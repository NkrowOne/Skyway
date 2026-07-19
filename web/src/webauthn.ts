import { api } from './api';

/**
 * Cliente WebAuthn mínimo: convierte entre el JSON base64url que habla el
 * servidor (@simplewebauthn/server) y los ArrayBuffer del API nativo.
 */

function b64uToBuf(value: string): ArrayBuffer {
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

function bufToB64u(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

/** Registra una passkey nueva para la cuenta con sesión iniciada. */
export async function registerPasskey(name: string): Promise<void> {
  const { options } = await api.post<{ options: any }>('/auth/passkeys/options');
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...options,
    challenge: b64uToBuf(options.challenge),
    user: { ...options.user, id: b64uToBuf(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c: any) => ({ ...c, id: b64uToBuf(c.id) })),
  };
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Registro cancelado');
  const att = cred.response as AuthenticatorAttestationResponse;
  await api.post('/auth/passkeys', {
    name,
    response: {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: (cred as any).authenticatorAttachment ?? undefined,
      response: {
        clientDataJSON: bufToB64u(att.clientDataJSON),
        attestationObject: bufToB64u(att.attestationObject),
        transports: (att as any).getTransports?.() ?? undefined,
      },
    },
  });
}

/** Inicia sesión con passkey (sin email: credencial descubrible). */
export async function loginWithPasskey(): Promise<void> {
  const { challengeId, options } = await api.post<{ challengeId: string; options: any }>('/auth/passkey-login/options');
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...options,
    challenge: b64uToBuf(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((c: any) => ({ ...c, id: b64uToBuf(c.id) })),
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Inicio cancelado');
  const asr = cred.response as AuthenticatorAssertionResponse;
  await api.post('/auth/passkey-login', {
    challengeId,
    response: {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: (cred as any).authenticatorAttachment ?? undefined,
      response: {
        clientDataJSON: bufToB64u(asr.clientDataJSON),
        authenticatorData: bufToB64u(asr.authenticatorData),
        signature: bufToB64u(asr.signature),
        userHandle: asr.userHandle ? bufToB64u(asr.userHandle) : undefined,
      },
    },
  });
}
