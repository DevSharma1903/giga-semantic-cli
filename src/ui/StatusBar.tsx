import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { telemetryStore } from './telemetryStore.js';
import { GIGA_VERSION } from '../config/version.js';

export const StatusBar = () => {
  const [modelId, setModelId] = useState(telemetryStore.modelId);
  const [tokensSlashed, setTokensSlashed] = useState(telemetryStore.tokensSlashed);
  const [latency, setLatency] = useState(telemetryStore.latency);

  useEffect(() => {
    const handleTelemetryChange = () => {
      setModelId(telemetryStore.modelId);
      setTokensSlashed(telemetryStore.tokensSlashed);
      setLatency(telemetryStore.latency);
    };

    telemetryStore.on('change', handleTelemetryChange);
    return () => {
      telemetryStore.off('change', handleTelemetryChange);
    };
  }, []);

  return (
    <Box flexDirection="row" borderStyle="single" borderColor="gray" justifyContent="center">
      <Text dimColor>
        giga v{GIGA_VERSION} | {modelId} | Tokens Slashed: {tokensSlashed.toFixed(2)}% | Latency: {latency}ms
      </Text>
    </Box>
  );
};
