import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { BleManager, Device } from 'react-native-ble-plx';
import RNBluetoothClassic, {
  BluetoothDevice as ClassicDevice,
  BluetoothEventSubscription,
} from 'react-native-bluetooth-classic';
import { PermissionsAndroid, Platform } from 'react-native';
import * as Location from 'expo-location';
import { Buffer } from 'buffer';

// BLE — used to send text to the glasses (HM-10 style serial profile)
const SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const CHARACTERISTIC_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';

// Classic BT (RFCOMM) — used to receive PCM16 audio from the glasses.
// The Pi sends newline-delimited base64 frames: each event from the
// delimiter-based reader is one base64-encoded PCM16 chunk. base64 is
// 7-bit ASCII (never contains 0x0A) so the newline framing is binary-safe.

export type AudioDataCallback = (pcm: Int16Array) => void;

interface BluetoothContextType {
  // BLE — text → glasses
  isScanning: boolean;
  devices: Device[];
  connectedDevice: Device | null;
  error: string | null;
  scanDevices: () => Promise<void>;
  connectToDevice: (device: Device) => Promise<Device | null>;
  disconnect: () => Promise<void>;
  sendData: (data: string) => Promise<void>;

  // Classic BT — audio ← glasses
  pairedAudioDevices: ClassicDevice[];
  audioDevice: ClassicDevice | null;
  isAudioStreaming: boolean;
  refreshPairedAudioDevices: () => Promise<void>;
  connectAudioDevice: (device: ClassicDevice) => Promise<boolean>;
  disconnectAudio: () => Promise<void>;
  /** Subscribe to PCM16 mono 16 kHz chunks. Returns an unsubscribe fn. */
  onAudioData: (cb: AudioDataCallback) => () => void;
}

const BluetoothContext = createContext<BluetoothContextType | undefined>(undefined);

const manager = new BleManager();

export const BluetoothProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // ── BLE state (text TX path, unchanged behaviour) ──────────────────────────
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);

  // ── Classic BT state (audio RX path) ───────────────────────────────────────
  const [pairedAudioDevices, setPairedAudioDevices] = useState<ClassicDevice[]>([]);
  const [audioDevice, setAudioDevice] = useState<ClassicDevice | null>(null);
  const [isAudioStreaming, setIsAudioStreaming] = useState(false);

  const audioSubscribersRef = useRef<Set<AudioDataCallback>>(new Set());
  const dataSubscriptionRef = useRef<BluetoothEventSubscription | null>(null);
  const disconnectSubscriptionRef = useRef<BluetoothEventSubscription | null>(null);

  // --- DIAGNOSTIC: aggregate ~1s of inbound-stream stats ---
  const audioDiagRef = useRef({ rawBytes: 0, samples: 0, sumSq: 0, peak: 0, events: 0 });
  const audioDiagTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      const { status: locationStatus } = await Location.requestForegroundPermissionsAsync();
      if (locationStatus !== 'granted') {
        setError('Location permission required for Bluetooth');
        return false;
      }

      if (Platform.Version >= 31) {
        const scanPerm = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN
        );
        const connectPerm = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
        );
        if (
          scanPerm !== PermissionsAndroid.RESULTS.GRANTED ||
          connectPerm !== PermissionsAndroid.RESULTS.GRANTED
        ) {
          setError('Bluetooth permissions required');
          return false;
        }
      }
    }
    return true;
  };

  const scanDevices = useCallback(async () => {
    const hasPermission = await requestPermissions();
    if (!hasPermission) return;

    setIsScanning(true);
    setDevices([]);
    setError(null);

    manager.startDeviceScan(null, null, (scanError, device) => {
      if (scanError) {
        console.error('Scan error:', scanError);
        setError(scanError.message);
        setIsScanning(false);
        return;
      }

      if (device && device.name) {
        setDevices((prev) => (prev.find((d) => d.id === device.id) ? prev : [...prev, device]));
      }
    });

    setTimeout(() => {
      manager.stopDeviceScan();
      setIsScanning(false);
    }, 10000);
  }, []);

  const connectToDevice = async (device: Device) => {
    try {
      manager.stopDeviceScan();
      setIsScanning(false);

      const connected = await device.connect();
      const discovered = await connected.discoverAllServicesAndCharacteristics();
      setConnectedDevice(discovered);
      setError(null);
      return discovered;
    } catch (e: any) {
      console.error('Connection error:', e);
      setError(e.message);
      return null;
    }
  };

  const disconnect = async () => {
    if (connectedDevice) {
      await connectedDevice.cancelConnection();
      setConnectedDevice(null);
    }
  };

  const sendData = async (data: string) => {
    if (!connectedDevice) return;

    try {
      const base64Data = Buffer.from(data, 'utf-8').toString('base64');
      await connectedDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        base64Data
      );
    } catch (e: any) {
      console.error('Send error:', e);
      setError(e.message);
    }
  };

  // ── Classic BT — audio reception ───────────────────────────────────────────

  const refreshPairedAudioDevices = useCallback(async () => {
    try {
      const hasPermission = await requestPermissions();
      if (!hasPermission) return;

      const enabled = await RNBluetoothClassic.isBluetoothEnabled();
      if (!enabled) {
        try {
          await RNBluetoothClassic.requestBluetoothEnabled();
        } catch {
          setError('Enable Bluetooth to receive audio');
          return;
        }
      }

      const bonded = await RNBluetoothClassic.getBondedDevices();
      setPairedAudioDevices(bonded);
    } catch (e: any) {
      console.error('Refresh paired devices error:', e);
      setError(e.message);
    }
  }, []);

  const stopAudioDiag = () => {
    if (audioDiagTimerRef.current) {
      clearInterval(audioDiagTimerRef.current);
      audioDiagTimerRef.current = null;
    }
  };

  // Decode one newline-delimited base64 frame (the library already stripped
  // the trailing "\n") into PCM16 samples and fan them out to subscribers.
  // Each frame is a complete chunk, so there is no cross-frame byte carry.
  const handleAudioFrame = (b64: string) => {
    const trimmed = b64.trim();
    if (trimmed.length === 0) return;

    let bytes: Buffer;
    try {
      bytes = Buffer.from(trimmed, 'base64');
    } catch {
      return;
    }
    if (bytes.length < 2) return;

    // PCM16 is 2 bytes/sample; drop a stray odd byte defensively.
    let len = bytes.length;
    if (len % 2 === 1) len -= 1;

    // Copy into a fresh ArrayBuffer so Int16Array is 2-byte aligned —
    // Buffer slices may not be.
    const aligned = new ArrayBuffer(len);
    new Uint8Array(aligned).set(bytes.subarray(0, len));
    const pcm16 = new Int16Array(aligned);

    // --- DIAGNOSTIC: accumulate stats (logged once/sec by the diag timer) ---
    const d = audioDiagRef.current;
    d.rawBytes += bytes.length;
    d.samples += pcm16.length;
    for (let i = 0; i < pcm16.length; i++) {
      const v = pcm16[i];
      d.sumSq += v * v;
      const a = v < 0 ? -v : v;
      if (a > d.peak) d.peak = a;
    }

    audioSubscribersRef.current.forEach((cb) => {
      try {
        cb(pcm16);
      } catch (cbErr) {
        console.error('Audio subscriber error:', cbErr);
      }
    });
  };

  const connectAudioDevice = useCallback(async (device: ClassicDevice) => {
    try {
      // DELIMITER "\n" makes the reader emit one base64 frame per event;
      // ISO-8859-1 maps every byte 1:1 to a JS code point so the base64
      // ASCII survives the plugin's string decoding intact.
      const connected = await device.connect({
        DELIMITER: '\n',
        DEVICE_CHARSET: 'ISO-8859-1',
      } as any);

      if (!connected) {
        setError('Failed to open audio device');
        return false;
      }

      dataSubscriptionRef.current = device.onDataReceived((evt) => {
        const data = evt?.data as unknown as string | undefined;
        audioDiagRef.current.events += 1;
        if (!data || data.length === 0) return;
        handleAudioFrame(data);
      });

      disconnectSubscriptionRef.current = RNBluetoothClassic.onDeviceDisconnected(() => {
        setAudioDevice(null);
        setIsAudioStreaming(false);
        stopAudioDiag();
        dataSubscriptionRef.current?.remove();
        dataSubscriptionRef.current = null;
      });

      // --- DIAGNOSTIC: log inbound-stream stats once per second ---
      stopAudioDiag();
      audioDiagRef.current = { rawBytes: 0, samples: 0, sumSq: 0, peak: 0, events: 0 };
      audioDiagTimerRef.current = setInterval(() => {
        const d = audioDiagRef.current;
        const rms = d.samples ? Math.sqrt(d.sumSq / d.samples) : 0;
        console.log(
          `[BT-AUDIO] events=${d.events} raw=${d.rawBytes}B/s samples=${d.samples}/s ` +
            `peak=${d.peak} rms=${rms.toFixed(0)} (norm=${(rms / 32768).toFixed(4)}) ` +
            `subs=${audioSubscribersRef.current.size}`
        );
        d.rawBytes = 0;
        d.samples = 0;
        d.sumSq = 0;
        d.peak = 0;
        d.events = 0;
      }, 1000);

      setAudioDevice(device);
      setIsAudioStreaming(true);
      setError(null);
      return true;
    } catch (e: any) {
      console.error('Audio connect error:', e);
      setError(e.message);
      return false;
    }
  }, []);

  const disconnectAudio = useCallback(async () => {
    try {
      stopAudioDiag();
      dataSubscriptionRef.current?.remove();
      disconnectSubscriptionRef.current?.remove();
      dataSubscriptionRef.current = null;
      disconnectSubscriptionRef.current = null;
      if (audioDevice) {
        try {
          await audioDevice.disconnect();
        } catch {
          // ignore — device may already be gone
        }
      }
    } finally {
      setAudioDevice(null);
      setIsAudioStreaming(false);
    }
  }, [audioDevice]);

  const onAudioData = useCallback((cb: AudioDataCallback) => {
    audioSubscribersRef.current.add(cb);
    return () => {
      audioSubscribersRef.current.delete(cb);
    };
  }, []);

  useEffect(
    () => () => {
      stopAudioDiag();
      dataSubscriptionRef.current?.remove();
      disconnectSubscriptionRef.current?.remove();
    },
    []
  );

  return (
    <BluetoothContext.Provider
      value={{
        isScanning,
        devices,
        connectedDevice,
        error,
        scanDevices,
        connectToDevice,
        disconnect,
        sendData,
        pairedAudioDevices,
        audioDevice,
        isAudioStreaming,
        refreshPairedAudioDevices,
        connectAudioDevice,
        disconnectAudio,
        onAudioData,
      }}
    >
      {children}
    </BluetoothContext.Provider>
  );
};

export const useBluetooth = () => {
  const context = useContext(BluetoothContext);
  if (context === undefined) {
    throw new Error('useBluetooth must be used within a BluetoothProvider');
  }
  return context;
};
