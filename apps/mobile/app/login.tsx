import { Link, Redirect } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/auth';
import { config, theme } from '../src/config';
import { Button, ErrorText, Field, styles } from '../src/ui';

export default function Login() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (auth.status === 'signed_in') return <Redirect href="/events" />;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await auth.signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 18 }}>
        <View style={{ gap: 6, marginBottom: 12 }}>
          <Text style={styles.h1}>Welcome back</Text>
          <Text style={styles.body}>Sign in to join the events you've been invited to.</Text>
        </View>
        {config.authMode === 'dev' && (
          <Text style={{ color: theme.warning }}>Local development sign-in — Cognito is bypassed.</Text>
        )}
        {config.authMode !== 'oidc' && (
          <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" />
        )}
        {config.authMode === 'cognito' && (
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" />
        )}
        {error && <ErrorText>{error}</ErrorText>}
        <Button
          title={config.authMode === 'oidc' ? `Continue with ${config.oidc.providerName}` : 'Sign in'}
          onPress={() => void submit()}
          loading={busy}
          disabled={config.authMode !== 'oidc' && !email}
        />
        {config.authMode === 'cognito' && (
          <Link href="/forgot-password" style={{ color: theme.brandLight, textAlign: 'center', fontWeight: '600', padding: 8 }}>
            Forgot password?
          </Link>
        )}
        <Text style={[styles.body, { textAlign: 'center', fontSize: 13 }]}>
          New here? Open your invitation email and create your account on the web, then sign in.
        </Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
