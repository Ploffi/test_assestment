import * as ngrok from '@ngrok/ngrok';
import type { Listener } from '@ngrok/ngrok';

export function requiredTunnelEnv(): string[] {
  return ['NGROK_AUTHTOKEN'];
}

export function readNgrokAuthtoken(): string {
  const token = process.env['NGROK_AUTHTOKEN'];
  if (!token) throw new Error('Missing NGROK_AUTHTOKEN');
  return token;
}

export async function startNgrokTunnel(port: number, authtoken: string): Promise<Listener> {
  const listener = await ngrok.forward({ addr: port, authtoken });
  const url = listener.url();
  if (!url) throw new Error('ngrok did not return a public URL');
  console.log(`Live GitHub E2E ngrok tunnel: ${url}`);
  return listener;
}
