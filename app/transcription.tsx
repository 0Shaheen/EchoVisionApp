import React, { useState, useEffect, useRef } from "react";
import { StyleSheet, View, Text, Pressable, ScrollView, ActivityIndicator, Alert, LogBox } from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from '@react-native-async-storage/async-storage';

// --- IMPORTS ---
import * as FileSystem from 'expo-file-system/legacy';
import { AudioModule } from 'expo-audio';
import * as Speech from 'expo-speech';
// @ts-ignore
import * as WhisperRN from 'whisper.rn';
import LiveAudioStream from 'react-native-live-audio-stream';
import { Buffer } from 'buffer';

// --- CUSTOM COMPONENTS ---
import { MicIcon, WaveformIcon, StopIcon, MicStartIcon, ClearIcon, BackIcon } from '@/components/Icons';
import { useBluetooth } from '../context/BluetoothContext';

// Define types for WhisperRN
interface WhisperContext {
  transcribeRealtime: (options: any) => Promise<{
    stop: () => Promise<void>;
    subscribe: (callback: (event: any) => void) => void;
  }>;
}

interface RealtimeTranscriberInstance {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  release: () => Promise<void>;
  on: (event: string, callback: (data: any) => void) => void;
}

const { initWhisper, RealtimeTranscriber } = WhisperRN as {
  initWhisper: (options: { filePath: string }) => Promise<WhisperContext>;
  RealtimeTranscriber: new (options: any) => RealtimeTranscriberInstance;
};

// --- SILENCE LOGS ---
LogBox.ignoreLogs(['transcribeRealtime', 'Falling back', 'statusBarTranslucent']);
const originalWarn = console.warn;
console.warn = (...args) => {
  const log = args.join(' ');
  if (log.includes('transcribeRealtime') || log.includes('statusBarTranslucent')) return;
  originalWarn(...args);
};

// --- MAIN COMPONENT ---

export default function Transcription() {
  const router = useRouter();
  const { connectedDevice, sendData, audioDevice, onAudioData } = useBluetooth();
  const [modelReady, setModelReady] = useState(false);
  const [modelPath, setModelPath] = useState<string | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState('en');
  const [selectedModel, setSelectedModel] = useState('tiny.en');
  const [isRemote, setIsRemote] = useState(false);
  const [serverUrl, setServerUrl] = useState('ws://192.168.1.100:3000/ws');
  const [messages, setMessages] = useState<string[]>([]);
  const [currentText, setCurrentText] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("Initializing...");

  const realtimeRef = useRef<RealtimeTranscriberInstance | null>(null);
  const stopLegacyRef = useRef<(() => Promise<void>) | null>(null);
  const whisperContextRef = useRef<WhisperContext | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const wsRef = useRef<WebSocket | null>(null);
  
  const lastSentTextRef = useRef("");
  const currentTextRef = useRef("");
  const silenceTimerRef = useRef<number | null>(null);
  const lastFinalizedTextRef = useRef("");
  const sessionPrefixRef = useRef("");

  // Bluetooth-audio routing: when the glasses are streaming PCM over RFCOMM
  // we use that instead of the phone microphone. The local path buffers
  // ~LOCAL_CHUNK_SEC of audio per call to whisper.rn's transcribe().
  const btUnsubRef = useRef<(() => void) | null>(null);
  const btFlushTimerRef = useRef<number | null>(null);
  const btBufferRef = useRef<Float32Array>(new Float32Array(0));
  const btTranscribingRef = useRef(false);
  const LOCAL_CHUNK_SEC = 3;
  const BT_SAMPLE_RATE = 16000;

  useEffect(() => {
    setupApp();
    return () => {
      stopRecordingSession();
      LiveAudioStream.stop();
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      Speech.stop();
    };
  }, []);

  useEffect(() => {
    if (modelReady && !isRecording && messages.length === 0 && currentText === "") {
      toggleRecording();
    }
  }, [modelReady]);

  useEffect(() => {
    currentTextRef.current = currentText;
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages, currentText]);

  const speakText = (text: string) => {
    Speech.stop(); 
    Speech.speak(text, { language: selectedLanguage === 'ar' ? 'ar-SA' : 'en-US', pitch: 1.0, rate: 0.9 });
  };

  const handleKeyboardPress = () => {
    setMessages([]);
    setCurrentText("");
    lastFinalizedTextRef.current = "";
    sessionPrefixRef.current = "";
    lastSentTextRef.current = "";
    if (connectedDevice) {
      sendData("cmd:clear"); // Send command to clear glasses LCD
    }
  };

  const stopRecordingSession = async () => {
    try {
      if (btUnsubRef.current) { btUnsubRef.current(); btUnsubRef.current = null; }
      if (btFlushTimerRef.current) {
        clearInterval(btFlushTimerRef.current);
        btFlushTimerRef.current = null;
      }
      btBufferRef.current = new Float32Array(0);
      btTranscribingRef.current = false;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      LiveAudioStream.stop();
      if (realtimeRef.current) {
        await realtimeRef.current.stop();
        await realtimeRef.current.release();
        realtimeRef.current = null;
      }
      if (stopLegacyRef.current) {
        await stopLegacyRef.current();
        stopLegacyRef.current = null;
      }
    } catch (e) { }
  };

  // 44-byte WAV header + interleaved PCM16 for whisper.rn's transcribe().
  const encodeWavPcm16 = (samples: Float32Array, sampleRate: number): Buffer => {
    const dataSize = samples.length * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);            // PCM
    buf.writeUInt16LE(1, 22);            // mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      buf.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), 44 + i * 2);
    }
    return buf;
  };

  // Save a buffered chunk, transcribe it via whisper.rn, hand result to the
  // normal handleNewTranscription path. Inflight guard avoids overlapping jobs.
  const transcribeBtChunk = async (chunk: Float32Array) => {
    if (!whisperContextRef.current) { console.log('[BT-WHISPER] no whisper context'); return; }
    if (btTranscribingRef.current) return;
    btTranscribingRef.current = true;

    // --- DIAGNOSTIC: measure the float chunk handed to whisper ---
    let sumSq = 0, peak = 0;
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i];
      sumSq += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, chunk.length));
    console.log(
      `[BT-WHISPER] transcribing ${chunk.length} samples ` +
      `(${(chunk.length / BT_SAMPLE_RATE).toFixed(1)}s) rms=${rms.toFixed(4)} peak=${peak.toFixed(3)}`
    );

    let path: string | null = null;
    try {
      const FS = FileSystem;
      const dir = FS.cacheDirectory ?? FS.documentDirectory;
      if (!dir) return;
      path = `${dir}bt-chunk-${Date.now()}.wav`;
      const wav = encodeWavPcm16(chunk, BT_SAMPLE_RATE);
      await FS.writeAsStringAsync(path, wav.toString('base64'), {
        encoding: FS.EncodingType.Base64,
      });
      const job: any = (whisperContextRef.current as any).transcribe(path, {
        language: selectedLanguage,
        beamSize: 1,
      });
      const result = await (job?.promise ?? job);
      const text = (result?.result ?? '').toString().trim();
      console.log(`[BT-WHISPER] result="${text}"`);
      if (text) handleNewTranscription(text);
    } catch (e) {
      console.warn('[BT-WHISPER] transcribe error:', e);
    } finally {
      btTranscribingRef.current = false;
      if (path) {
        try { await FileSystem.deleteAsync(path, { idempotent: true }); } catch {}
      }
    }
  };

  const requestMicrophonePermission = async () => {
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        Alert.alert("Permission Required", "Go to Settings > Apps and enable Microphone access.");
        return false;
      }
      return true;
    } catch (error) { return false; }
  };

  const setupApp = async () => {
    try {
      const lang = await AsyncStorage.getItem('language');
      const model = await AsyncStorage.getItem('model');
      const remote = await AsyncStorage.getItem('isRemote');
      const savedServerUrl = await AsyncStorage.getItem('serverUrl');

      if (lang) setSelectedLanguage(lang);
      if (remote) setIsRemote(remote === 'true');
      
      if (savedServerUrl) {
        setServerUrl(savedServerUrl);
      } else {
        const savedIp = await AsyncStorage.getItem('serverIp') || '192.168.1.100';
        const savedPort = await AsyncStorage.getItem('serverPort') || '3000';
        setServerUrl(`ws://${savedIp}:${savedPort}/ws`);
      }
      
      const defaultModel = remote === 'true' ? 'small' : 'tiny.en';
      if (model) setSelectedModel(model);
      else setSelectedModel(defaultModel);
      
      if (remote === 'true') {
        setModelReady(true);
        setStatus("Remote Ready");
      } else {
        await setupModel(model || 'tiny.en');
      }
    } catch (e) {
      console.error("Setup error:", e);
      setStatus("Error loading settings");
    }
  };

  const setupModel = async (modelId: string) => {
    setStatus("Checking Model...");
    const FS = FileSystem;
    if (!FS.documentDirectory) return;
    const fileDir = FS.documentDirectory + 'whisper-models/';
    const fileUri = fileDir + `ggml-${modelId}.bin`;
    
    try {
      const dirInfo = await FS.getInfoAsync(fileDir);
      if (!dirInfo.exists) await FS.makeDirectoryAsync(fileDir);
      const fileInfo = await FS.getInfoAsync(fileUri);
      if (!fileInfo.exists) {
        setStatus("Downloading Model...");
        const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelId}.bin`;
        await FS.downloadAsync(url, fileUri);
      }
      setModelPath(fileUri);
      setStatus("Loading Core...");
      if (initWhisper) {
        whisperContextRef.current = await initWhisper({ filePath: fileUri });
        setModelReady(true);
        setStatus("Ready");
      }
    } catch (error) { setStatus("Error loading model"); }
  };

  const handleNewTranscription = (text: string) => {
    if (!text) return;
    if (lastSentTextRef.current === "" && sessionPrefixRef.current === "" && lastFinalizedTextRef.current !== "") {
       const trimmedText = text.trim().toLowerCase();
       const trimmedFinalized = lastFinalizedTextRef.current.trim().toLowerCase();
       if (trimmedText.startsWith(trimmedFinalized)) {
          sessionPrefixRef.current = text.slice(0, lastFinalizedTextRef.current.length);
       }
    }
    let cleanText = text;
    if (sessionPrefixRef.current && text.startsWith(sessionPrefixRef.current)) {
       cleanText = text.slice(sessionPrefixRef.current.length);
    }
    if (!cleanText || cleanText === lastSentTextRef.current) return;
    const noisePatterns = [/\[BLANK_AUDIO\]/i, /\[music\]/i, /\[silence\]/i, /\[noise\]/i, /\(music\)/i , /\[SOUND]/i ];
    if (noisePatterns.some(pattern => pattern.test(cleanText))) return;

    let delta = cleanText.startsWith(lastSentTextRef.current) ? cleanText.slice(lastSentTextRef.current.length) : " " + cleanText;

    if (delta.trim().length > 0) {
      setCurrentText(cleanText);
      if (connectedDevice) sendData(delta);
      lastSentTextRef.current = cleanText;

      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(async () => {
        if (currentTextRef.current.trim().length > 0) {
          setMessages(prev => [...prev, currentTextRef.current]);
          lastFinalizedTextRef.current = currentTextRef.current;
          setCurrentText(""); lastSentTextRef.current = ""; sessionPrefixRef.current = "";
          if (isRemote) {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "reset" }));
          } else {
            await stopRecordingSession();
            setIsRecording(false);
            setTimeout(() => { toggleRecording(); }, 300);
          }
        }
      }, 2000) as unknown as number;
    }
  };

  const toggleRecording = async () => {
    if (!modelReady) return;
    if (isRecording) {
      await stopRecordingSession();
      setIsRecording(false);
      if (currentText.trim().length > 0) {
        setMessages(prev => [...prev, currentText]);
        lastFinalizedTextRef.current = currentText;
        setCurrentText(""); lastSentTextRef.current = ""; sessionPrefixRef.current = "";
      }
    } else {
      const useBtAudio = !!audioDevice;
      console.log(
        `[REC] start: isRemote=${isRemote} useBtAudio=${useBtAudio} ` +
        `hasWhisper=${!!whisperContextRef.current} hasRealtime=${!!RealtimeTranscriber} modelPath=${!!modelPath}`
      );
      if (!useBtAudio) {
        const hasPermission = await requestMicrophonePermission();
        if (!hasPermission) return;
      }
      setIsRecording(true);
      setCurrentText(""); lastSentTextRef.current = ""; sessionPrefixRef.current = "";
      try {
        if (isRemote) {
          if (!serverUrl) { 
            Alert.alert("Error", "Server URL is not configured");
            setIsRecording(false); 
            return; 
          }
          const trimmedUrl = serverUrl.trim();
          console.log("Connecting to WebSocket:", trimmedUrl);
          let ws: WebSocket;
          try {
            ws = new WebSocket(trimmedUrl);
            wsRef.current = ws;
          } catch (createError: any) {
            console.error("WebSocket Constructor Error:", createError);
            Alert.alert("Connection Error", `Could not create WebSocket for ${trimmedUrl}: ${createError.message}`);
            setIsRecording(false);
            return;
          }

          ws.onopen = () => {
            console.log("WebSocket Connected");
            ws.send(JSON.stringify({ type: "set_language", language: selectedLanguage }));
            ws.send(JSON.stringify({ type: "reset" }));

            try {
              if (useBtAudio) {
                // Pipe PCM16 received over Bluetooth straight to the server.
                btUnsubRef.current = onAudioData((pcm) => {
                  if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
                  }
                });
              } else {
                LiveAudioStream.init({ sampleRate: 16000, channels: 1, bitsPerSample: 16, audioSource: 6, bufferSize: 4096, wavFile: "" });
                LiveAudioStream.on('data', (d) => {
                  if (ws && ws.readyState === WebSocket.OPEN) {
                    const b = Buffer.from(d, 'base64');
                    ws.send(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
                  }
                });
                LiveAudioStream.start();
              }
            } catch (audioError: any) {
              console.error("Audio initialization error:", audioError);
              Alert.alert("Audio Error", "Failed to start audio streaming.");
            }
          };
          
          ws.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data);
              if (data.type === "partial" || data.type === "final") handleNewTranscription(data.text);
              else if (data.type === "download_start") setStatus(`Downloading ${data.model}...`);
              else if (data.type === "download_progress") setStatus(`Downloading ${data.model}: ${Math.round(data.progress)}%`);
              else if (data.type === "download_complete") setStatus(`Model ready.`);
              else if (data.type === "switching_model") setStatus(`Switching to ${data.model}...`);
              else if (data.type === "switched_model") setStatus(`Ready (Remote: ${data.model})`);
              else if (data.type === "error") {
                console.error("Server Error:", data.message);
                setStatus("Server Error");
              }
            } catch (parseError) {
              console.error("Message parse error:", parseError);
            }
          };
          
          ws.onerror = (e: any) => { 
            console.error("WebSocket Error Object:", e);
            const errorMsg = e.message || "Connection refused or server unreachable.";
            Alert.alert("Connection Error", `Failed to connect to ${trimmedUrl}.\n\nReason: ${errorMsg}\n\nCheck if the server is running on the correct IP and port.`);
            setIsRecording(false); 
            stopRecordingSession(); 
          };
          
          ws.onclose = (e) => {
            console.log("WebSocket Closed:", e.code, e.reason);
            setIsRecording(false);
          };
        } else if (useBtAudio && whisperContextRef.current) {
           // Local Whisper fed from the Bluetooth audio stream: accumulate
           // PCM samples and flush LOCAL_CHUNK_SEC at a time to transcribe().
           btBufferRef.current = new Float32Array(0);
           btUnsubRef.current = onAudioData((pcm) => {
             const fl = new Float32Array(pcm.length);
             for (let i = 0; i < pcm.length; i++) fl[i] = pcm[i] / 32768.0;
             const merged = new Float32Array(btBufferRef.current.length + fl.length);
             merged.set(btBufferRef.current, 0);
             merged.set(fl, btBufferRef.current.length);
             btBufferRef.current = merged;
           });
           btFlushTimerRef.current = setInterval(() => {
             const minSamples = BT_SAMPLE_RATE * LOCAL_CHUNK_SEC;
             // --- DIAGNOSTIC: buffer fill state each flush tick ---
             console.log(
               `[BT-FLUSH] buffer=${btBufferRef.current.length}/${minSamples} ` +
               `transcribing=${btTranscribingRef.current}`
             );
             if (btBufferRef.current.length < minSamples) return;
             if (btTranscribingRef.current) return;
             const chunk = btBufferRef.current;
             btBufferRef.current = new Float32Array(0);
             void transcribeBtChunk(chunk);
           }, 500) as unknown as number;
        } else if (RealtimeTranscriber) {
           const realtime = new RealtimeTranscriber({
             filePath: modelPath!, language: selectedLanguage, maxLen: 1, beamSize: 1, realtimeAudioSec: 60,
             vad: { enable: true, lowThreshold: 0.6, minSpeechDurationMs: 100 }
           });
           realtime.on('transcribe', (data: any) => { if (data?.result) handleNewTranscription(data.result); });
           await realtime.start();
           realtimeRef.current = realtime;
        } else if (whisperContextRef.current) {
           // Fallback to legacy transcribeRealtime if RealtimeTranscriber is not available or fails
           const options: any = {
             language: selectedLanguage, maxLen: 1, beamSize: 1, realtimeAudioSec: 60, audioSessionOnStart: true, 
           };
           const { stop, subscribe } = await whisperContextRef.current.transcribeRealtime(options);
           stopLegacyRef.current = stop;
           subscribe((event: any) => { if (event.data?.result) handleNewTranscription(event.data.result); });
        }
      } catch (e) { 
        setIsRecording(false);
        const errStr = String(e);
        if (errStr.includes("-100")) {
           Alert.alert("Microphone Error", "Initialization failed (State: -100). This often happens if the microphone is busy. Restart the app.");
        } else {
           Alert.alert("Error", "Could not start recording. " + errStr);
        }
      }
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <BackIcon width={22} height={22} color="#1A1A1A" />
        </Pressable>
        <Text style={styles.headerTitle}>Transcription</Text>
        <View style={styles.headerBadges}>
          {isRemote && (
            <View style={[styles.statusBadge, { backgroundColor: '#E0EEFF' }]}>
              <View style={[styles.statusDot, { backgroundColor: '#007AFF' }]} />
              <Text style={[styles.statusBadgeText, { color: '#007AFF' }]}>Remote</Text>
            </View>
          )}
          {connectedDevice && (
            <View style={[styles.statusBadge, { backgroundColor: '#E8F5E9' }]}>
              <View style={[styles.statusDot, { backgroundColor: '#34C759' }]} />
              <Text style={[styles.statusBadgeText, { color: '#34C759' }]}>CONNECTED</Text>
            </View>
          )}
          {audioDevice && (
            <View style={[styles.statusBadge, { backgroundColor: '#FFF4E0' }]}>
              <View style={[styles.statusDot, { backgroundColor: '#FF9500' }]} />
              <Text style={[styles.statusBadgeText, { color: '#FF9500' }]}>BT MIC</Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.contentFrame}>
        {!modelReady && (
          <View style={styles.loaderContainer}>
            <ActivityIndicator color="#007AFF" />
            <Text style={styles.statusText}>{status}</Text>
          </View>
        )}

        <ScrollView 
          ref={scrollViewRef}
          style={styles.scrollView} 
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {messages.length === 0 && currentText === "" && modelReady && (
            <View style={styles.emptyPrompt}>
              <Text style={styles.emptyPromptText}>Awaiting voice input...</Text>
              <Text style={styles.emptyPromptSub}>Hardware bridge is active.</Text>
            </View>
          )}

          {messages.map((msg, index) => (
            <View key={index} style={styles.messageCard}>
              <Text style={styles.messageText}>{msg}</Text>
              <Pressable 
                style={styles.speakButton}
                onPress={() => speakText(msg)}
                hitSlop={15}
              >
                <MicIcon width={12} height={16} color="#007AFF" />
              </Pressable>
            </View>
          ))}

          {currentText.length > 0 && (
            <View style={[styles.messageCard, styles.activeMessageCard]}>
              <Text style={[styles.messageText, styles.activeMessageText]}>{currentText}</Text>
              <View style={styles.activeIndicator}>
                <ActivityIndicator size="small" color="#007AFF" />
              </View>
            </View>
          )}
        </ScrollView>
      </View>

      <View style={styles.footer}>
          <Pressable style={styles.footerIconButton} onPress={handleKeyboardPress}>
             <ClearIcon width={24} height={24} color="#1A1A1A" />
          </Pressable>
          <View style={styles.waveformContainer}>
             <WaveformIcon color={isRecording ? "#FF3B30" : "#007AFF"} />
          </View>
          <Pressable 
            style={[styles.recordButton, isRecording && styles.recordButtonActive]} 
            onPress={toggleRecording}
            disabled={!modelReady}
          >
            {isRecording ? (
              <StopIcon width={28} height={28} color="#FF3B30" />
            ) : (
              <MicStartIcon width={28} height={28} color={!modelReady ? "#C7C7CC" : "#007AFF"} />
            )}
          </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F9FA', paddingTop: 60 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, marginBottom: 20, width: '100%' },
  backButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: "#FFFFFF", justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: "#E5E5E5", marginRight: 16 },
  headerTitle: { fontSize: 24, fontWeight: "800", color: "#1A1A1A" },
  headerBadges: { flexDirection: 'row', marginLeft: 'auto', gap: 8 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, gap: 6 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusBadgeText: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  contentFrame: { flex: 1, width: "100%", backgroundColor: '#FFFFFF', borderTopLeftRadius: 32, borderTopRightRadius: 32, borderWidth: 1, borderColor: '#E5E5E5', overflow: 'hidden' },
  loaderContainer: { padding: 20, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 12, borderBottomWidth: 1, borderBottomColor: '#F2F2F7' },
  statusText: { color: "#8E8E93", fontSize: 14, fontWeight: '600' },
  scrollView: { flex: 1 },
  scrollContent: { padding: 24, gap: 16, paddingBottom: 40 },
  emptyPrompt: { marginTop: 60, alignItems: 'center', gap: 8 },
  emptyPromptText: { fontSize: 18, fontWeight: '700', color: '#AEAEB2' },
  emptyPromptSub: { fontSize: 14, fontWeight: '500', color: '#C7C7CC' },
  messageCard: { width: "100%", backgroundColor: "#F2F2F7", padding: 18, paddingBottom: 30, borderRadius: 20, borderWidth: 1, borderColor: 'transparent', position: 'relative' },
  activeMessageCard: { backgroundColor: "#FFFFFF", borderColor: "#007AFF", borderWidth: 1.5 },
  messageText: { fontSize: 16, fontWeight: "600", color: "#1C1C1E", lineHeight: 24 },
  activeMessageText: { color: "#007AFF" },
  speakButton: { position: 'absolute', bottom: 12, right: 12, width: 32, height: 32, borderRadius: 16, backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center', shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 2 },
  activeIndicator: { position: 'absolute', bottom: 12, right: 12 },
  footer: { width: "100%", height: 100, backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#E5E5E5', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 20 },
  footerIconButton: { width: 54, height: 54, justifyContent: 'center', alignItems: 'center', backgroundColor: "#F2F2F7", borderRadius: 27 },
  recordButton: { width: 64, height: 64, justifyContent: 'center', alignItems: 'center', backgroundColor: "#F2F2F7", borderRadius: 32, borderWidth: 1, borderColor: "#E5E5E5" },
  recordButtonActive: { borderColor: "#FF3B30", backgroundColor: "#FFF1F0" },
  waveformContainer: { flex: 1, height: 54, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 }
});
