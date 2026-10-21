// Must be imported before anything else (see app/_layout.tsx).
import 'react-native-get-random-values'; // crypto.getRandomValues for Amplify
import '@aws-amplify/react-native';
import { registerGlobals } from '@livekit/react-native';

// Installs WebRTC globals (RTCPeerConnection, MediaStream, ...) that livekit-client expects.
registerGlobals();
