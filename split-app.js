const fs = require('fs');
const appPath = './example/src/App.tsx';
const contentPath = './example/src/Content.tsx';

let source = fs.readFileSync(appPath, 'utf8');

// The line "// --- Render Functions ---" indicates the split roughly.
const renderStart = source.indexOf('  // --- Render Functions ---');
const componentEnd = source.indexOf('const styles = StyleSheet.create({');

const stateCode = source.slice(0, renderStart);
const renderCode = source.slice(renderStart, componentEnd);
const stylesCode = source.slice(componentEnd);

let newAppCode = stateCode.replace(
  "import {\n  Text,\n  View,\n  StyleSheet,\n  TouchableOpacity,\n  ScrollView,\n  Platform,\n  SafeAreaView,\n  StatusBar,\n  TextInput,\n  LayoutAnimation,\n  ActivityIndicator,\n  UIManager,\n} from 'react-native';",
  `import {
  Platform,
  LayoutAnimation,
  UIManager,
} from 'react-native';\nimport { Content, type LogEntry } from './Content';`
);

newAppCode = newAppCode.replace(
  'interface LogEntry',
  '// LogEntry moved to Content\n/* interface LogEntry'
);
newAppCode = newAppCode.replace(
  'export default function App() {',
  '*/\n\nexport default function App() {'
);

newAppCode = newAppCode.replace(
  'const COLORS = {',
  '// COLORS moved\n/* const COLORS = {'
);
newAppCode = newAppCode.replace(
  'interface LogEntry {',
  '*/\n\n/* interface LogEntry {'
);

let appContentReturn = `
  return (
    <Content
      logs={logs}
      isConnected={isConnected}
      isConnecting={isConnecting}
      useInterceptor={useInterceptor}
      stats={stats}
      url={url}
      batching={batching}
      headersJson={headersJson}
      manualId={manualId}
      method={method}
      body={body}
      connectionTimeout={connectionTimeout}
      readTimeout={readTimeout}
      showConfig={showConfig}
      scrollViewRef={scrollViewRef}
      setLogs={setLogs}
      setUrl={setUrl}
      setBatching={setBatching}
      setMethod={setMethod}
      setBody={setBody}
      setConnectionTimeout={setConnectionTimeout}
      setReadTimeout={setReadTimeout}
      setHeadersJson={setHeadersJson}
      setManualId={setManualId}
      setUseInterceptor={setUseInterceptor}
      startConnection={startConnection}
      stopConnection={stopConnection}
      manualFlush={manualFlush}
      manualRestart={manualRestart}
      toggleConfig={toggleConfig}
      applyCustomHeaders={applyCustomHeaders}
      applyManualId={applyManualId}
    />
  );
}
`;

fs.writeFileSync(appPath, newAppCode + appContentReturn);

fs.writeFileSync(
  contentPath,
  `import React from 'react';
import {
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  SafeAreaView,
  StatusBar,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import type { SseStats } from 'react-native-nitro-sse';

export const COLORS = {
  background: '#0F172A',
  card: '#1E293B',
  primary: '#38BDF8',
  success: '#10B981',
  error: '#EF4444',
  warning: '#F59E0B',
  text: '#F8FAFC',
  textDim: '#94A3B8',
  border: '#334155',
  accent: '#7C3AED',
};

export interface LogEntry {
  id: string;
  time: string;
  type: string;
  data?: string;
  message?: string;
  statusCode?: number;
}

export interface ContentProps {
  logs: LogEntry[];
  isConnected: boolean;
  isConnecting: boolean;
  useInterceptor: boolean;
  stats: SseStats;
  url: string;
  batching: string;
  headersJson: string;
  manualId: string;
  method: 'get' | 'post';
  body: string;
  connectionTimeout: string;
  readTimeout: string;
  showConfig: boolean;
  scrollViewRef: any;
  setLogs: (logs: LogEntry[]) => void;
  setUrl: (url: string) => void;
  setBatching: (val: string) => void;
  setMethod: (val: 'get' | 'post') => void;
  setBody: (val: string) => void;
  setConnectionTimeout: (val: string) => void;
  setReadTimeout: (val: string) => void;
  setHeadersJson: (val: string) => void;
  setManualId: (val: string) => void;
  setUseInterceptor: (val: boolean) => void;
  startConnection: () => void;
  stopConnection: () => void;
  manualFlush: () => void;
  manualRestart: () => void;
  toggleConfig: () => void;
  applyCustomHeaders: () => void;
  applyManualId: () => void;
}

export function Content(props: ContentProps) {
  const {
    logs,
    isConnected,
    isConnecting,
    useInterceptor,
    stats,
    url,
    batching,
    headersJson,
    manualId,
    method,
    body,
    connectionTimeout,
    readTimeout,
    showConfig,
    scrollViewRef,
    setLogs,
    setUrl,
    setBatching,
    setMethod,
    setBody,
    setConnectionTimeout,
    setReadTimeout,
    setHeadersJson,
    setManualId,
    setUseInterceptor,
    startConnection,
    stopConnection,
    manualFlush,
    manualRestart,
    toggleConfig,
    applyCustomHeaders,
    applyManualId,
  } = props;

` +
    renderCode.replace('  return (', '  return (') +
    '\\n\\n' +
    stylesCode
);
