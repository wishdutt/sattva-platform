import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { useAuth } from '../src/auth';
import { Button, ErrorText, Field, styles } from '../src/ui';

export default function ForgotPassword() {
  const auth = useAuth();
  const [step, setStep] = useState<'request' | 'confirm'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (step === 'request') {
        await auth.requestPasswordReset(email);
        setStep('confirm');
      } else {
        await auth.confirmPasswordReset(email, code, password);
        router.replace('/login');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 24, gap: 18 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.body}>
        {step === 'request' ? 'Enter your email and we will send you a reset code.' : `Enter the code we sent to ${email}.`}
      </Text>
      {step === 'request' ? (
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      ) : (
        <>
          <Field label="Reset code" value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" />
          <Field label="New password" value={password} onChangeText={setPassword} secureTextEntry textContentType="newPassword" />
        </>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <Button title={step === 'request' ? 'Send code' : 'Set new password'} onPress={() => void submit()} loading={busy} />
    </ScrollView>
  );
}
