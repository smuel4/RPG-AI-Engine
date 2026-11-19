import { useState } from 'react';
import type { User } from 'firebase/auth';

interface Props {
  user: User | null;
  campaignId: string | null;
}

export function DevAuthProbe({ user, campaignId }: Props) {
  const [result, setResult] = useState('Ainda não testado');
  const [testing, setTesting] = useState(false);

  if (!import.meta.env.DEV || !user) return null;

  async function testAuthentication() {
    if (!user || !campaignId) {
      setResult('Selecione uma campanha primeiro');
      return;
    }

    setTesting(true);
    setResult('Verificando...');

    try {
      const token = await user.getIdToken();

      const response = await fetch('/api/narrator/turn', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ campaignId }),
      });

      setResult(`HTTP STATUS: ${response.status}`);
    } catch {
      setResult('ERRO: não foi possível completar o teste');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 rounded-lg bg-slate-900 p-3 text-white shadow-lg">
      <button
        type="button"
        onClick={testAuthentication}
        disabled={testing}
        className="rounded bg-amber-500 px-3 py-2 font-semibold text-black disabled:opacity-50"
      >
        Testar autenticação Firebase
      </button>
      <p className="mt-2 text-sm">{result}</p>
    </div>
  );
}

