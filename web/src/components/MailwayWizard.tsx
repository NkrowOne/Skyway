import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Download, ExternalLink, Mail, Plus, X } from 'lucide-react';
import { api, ApiError } from '../api';
import { Button } from './ui';

interface Connection { enabled: boolean; routingConnected: boolean; domains: string[] }
interface Report {
  configured: boolean; partial?: boolean; domain: string; webmailUrl?: string;
  ready?: boolean; mailStatus?: string; webmailStatus?: string; webmailDetail?: string;
  accounts?: string[]; zone?: string; warning?: string | null; dnsUnknown?: boolean;
  checks?: { id: string; label: string; status: string; help: string; required: boolean }[];
}
function saveFile(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function password() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), b => alphabet[b % alphabet.length]).join('');
}

export default function MailwayWizard({ serviceId, savedDomains }: { serviceId: string; savedDomains: string[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const connection = useQuery({ queryKey: ['mailway', serviceId, savedDomains],
    queryFn: () => api.get<Connection>(`/services/${serviceId}/mailway`), retry: false, refetchInterval: 30_000 });
  if (connection.error instanceof ApiError && connection.error.status === 403) return null;
  const domains = connection.data?.domains || [];
  const domain = domains.includes(selected) ? selected : domains[0] || '';
  return <div className="mt-5 border-t border-line pt-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="flex items-center gap-2 text-sm font-medium text-txt"><Mail size={16} /> Correo con tu dominio</h3>
        <p className="mt-1 text-xs text-sub">Tu web, tus direcciones y tu webmail, en el mismo sitio.</p></div>
      <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>{open ? 'Cerrar asistente' : 'Configurar correo'}</Button>
    </div>
    {open && <div className="mt-4">
      {connection.isPending ? <p className="text-sm text-sub">Comprobando conexión…</p> : connection.error ? <p role="alert" className="text-sm text-warn">{connection.error.message}</p> : !connection.data?.enabled ?
        <p className="text-sm text-sub">El administrador debe conectar Mailway una vez en Skyway. Después podrás preparar el correo de cada dominio desde aquí.</p> : domains.length === 0 ?
        <p className="text-sm text-sub">Añade y guarda primero tu dominio raíz arriba, por ejemplo <strong className="text-txt">codanuancelegal.com</strong>. La web y el correo compartirán ese dominio.</p> : <>
          <label className="mb-4 block text-xs text-sub">Dominio de tu empresa
            <select className="input mt-2 w-full" value={domain} onChange={e => setSelected(e.target.value)}>{domains.map(d => <option key={d}>{d}</option>)}</select>
          </label>
          <DomainSetup key={`${serviceId}:${domain}`} serviceId={serviceId} domain={domain} routing={!!connection.data.routingConnected} />
        </>}
    </div>}
  </div>;
}

function DomainSetup({ serviceId, domain, routing }: { serviceId: string; domain: string; routing: boolean }) {
  const base = `/services/${serviceId}/mailway`;
  const [step, setStep] = useState(1);
  const [accounts, setAccounts] = useState(() => ['info', 'no-reply', 'postmaster'].map(localPart => ({ localPart, password: password(), required: localPart === 'postmaster' })));
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [result, setResult] = useState<Report | null>(null);
  const status = useQuery({ queryKey: ['mailway-status', serviceId, domain], queryFn: () => api.post<Report>(`${base}/status`, { domain }), retry: false });
  const report = result || status.data;
  const stage = report?.configured ? 3 : step;
  const provision = useMutation({ mutationFn: () => api.post<Report>(`${base}/provision`, { domain, accounts }), onSuccess: data => {
    setResult(data); setAccounts(current => current.map(a => ({ ...a, password: '' })));
  }, onError: () => { void status.refetch(); } });
  const verify = useMutation({ mutationFn: () => api.post<Report>(`${base}/verify`, { domain }), onSuccess: setResult });
  const valid = accounts.length > 0 && accounts.every(a => /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(a.localPart) && a.password.length >= 12) &&
    new Set(accounts.map(a => a.localPart)).size === accounts.length && accounts.some(a => a.localPart === 'postmaster');
  const update = (i: number, patch: Partial<typeof accounts[number]>) => { setAccounts(accounts.map((a, j) => i === j ? { ...a, ...patch } : a)); setSaved(false); };
  const existing = (local: string) => !!status.data?.accounts?.includes(`${local}@${domain}`);
  if (status.isPending) return <p className="text-sm text-sub">Buscando la configuración de este dominio…</p>;
  if (status.error) return <div role="alert" className="text-sm text-warn">{status.error.message}<Button size="sm" variant="secondary" onClick={() => status.refetch()}>Reintentar</Button></div>;
  return <div className="overflow-hidden rounded-xl border border-line bg-surface">
    <ol className="grid grid-cols-3 border-b border-line text-xs">{['Tu dominio', 'Tus cuentas', 'Conectar DNS'].map((label, i) =>
      <li key={label} aria-current={stage === i + 1 ? 'step' : undefined} className={`border-b-2 px-3 py-3 ${stage === i + 1 ? 'border-acc text-txt' : 'border-transparent text-subtle'}`}>{i + 1}. {label}</li>)}</ol>
    <div className="p-4 sm:p-5">
      {stage === 1 && <>
        <p className="text-xs uppercase tracking-wider text-subtle">Una dirección que habla de ti</p>
        <h4 className="mt-2 break-all text-xl font-semibold text-txt">info@{domain}</h4>
        <p className="mt-3 text-sm leading-relaxed text-sub">Preparamos las cuentas y la configuración. Al terminar, solo tendrás que importar el archivo DNS en Cloudflare.</p>
        <dl className="my-5 space-y-3 text-sm"><div><dt className="text-subtle">Tu web</dt><dd className="break-all text-txt">{domain}</dd></div><div><dt className="text-subtle">Tu webmail</dt><dd className="break-all text-txt">webmail.{domain}</dd></div></dl>
        <Button onClick={() => setStep(2)}>Elegir mis cuentas <ArrowRight size={14} /></Button>
      </>}
      {stage === 2 && <>
        <h4 className="text-base font-semibold text-txt">¿Qué direcciones necesitas?</h4>
        <p className="mt-2 text-sm text-sub">Info para consultas, no-reply para envíos automáticos y postmaster para avisos técnicos. Son buzones reales, cada uno con su contraseña.</p>
        <div className="my-4 space-y-4">{accounts.map((a, i) => <div key={i} className="grid gap-2 border-b border-line pb-4 sm:grid-cols-2">
          <label className="min-w-0 text-xs text-sub">Dirección<div className="mt-1 flex items-center gap-1"><input aria-label={`Nombre de cuenta ${i + 1}`} className="input w-full min-w-0" value={a.localPart} disabled={a.required || provision.isPending} onChange={e => update(i, { localPart: e.target.value.trim().toLowerCase() })} />
            {!a.required && <Button variant="ghost" size="sm" aria-label={`Quitar ${a.localPart || 'cuenta'}`} disabled={provision.isPending} onClick={() => { setAccounts(accounts.filter((_, j) => i !== j)); setSaved(false); }}><X size={14} /></Button>}</div><span className="mt-1 block truncate">@{domain}</span></label>
          {existing(a.localPart) ? <p className="self-center text-xs text-sub">Esta cuenta ya existe. Conserva su contraseña anterior; puedes restablecerla desde Mailway.</p> : <label className="text-xs text-sub">Contraseña<input aria-label={`Contraseña de ${a.localPart}`} className="input mt-1 w-full font-mono" type={show ? 'text' : 'password'} autoComplete="new-password" value={a.password} disabled={provision.isPending} onChange={e => update(i, { password: e.target.value })} /><span className="mt-1 block text-subtle">Al menos 12 caracteres</span></label>}
        </div>)}</div>
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" disabled={accounts.length >= 20 || provision.isPending} onClick={() => { setAccounts([...accounts, { localPart: '', password: password(), required: false }]); setSaved(false); }}><Plus size={13} /> Añadir cuenta</Button>
          <Button size="sm" variant="ghost" onClick={() => setShow(!show)}>{show ? 'Ocultar contraseñas' : 'Ver contraseñas'}</Button>
          <Button size="sm" variant="secondary" disabled={!valid} onClick={() => saveFile(`${domain}-accesos.txt`, `Webmail: https://webmail.${domain}\nGuarda este archivo en un lugar privado. Las cuentas existentes conservan sus contraseñas anteriores.\n\n${accounts.filter(a => !existing(a.localPart)).map(a => `${a.localPart}@${domain}\nContraseña: ${a.password}`).join('\n\n')}`)}><Download size={13} /> Guardar nuevos accesos</Button></div>
        <label className="my-4 flex items-start gap-2 text-sm text-sub"><input type="checkbox" className="mt-1" checked={saved} onChange={e => setSaved(e.target.checked)} />He guardado las contraseñas en un lugar seguro.</label>
        {!valid && <p className="mb-3 text-sm text-warn">Revisa las cuentas: nombres únicos con letras, números, puntos o guiones, y contraseñas de al menos 12 caracteres.</p>}
        {!routing && <p className="mb-3 text-sm text-warn">Falta conectar el proxy de Skyway con Mailway. El administrador debe revisar la integración.</p>}
        {report?.partial && <p className="mb-3 text-sm text-sub">Hay un alta incompleta. Se conservarán las cuentas ya creadas y sus contraseñas.</p>}
        <div className="flex gap-2"><Button variant="secondary" disabled={provision.isPending} onClick={() => setStep(1)}>Atrás</Button><Button loading={provision.isPending} disabled={!valid || !saved || !routing} onClick={() => provision.mutate()}>Crear correo <ArrowRight size={14} /></Button></div>
      </>}
      {stage === 3 && report && <>
        <h4 className="text-base font-semibold text-txt">{report.ready ? 'DNS y webmail comprobados' : 'Ya están tus cuentas. Conecta el dominio.'}</h4>
        <p className="mt-2 break-all text-sm text-sub">{report.accounts?.join(' · ')}</p>
        <ol className="my-5 space-y-3 text-sm text-sub"><li>1. Descarga el archivo de DNS.</li><li>2. En Cloudflare, abre tu dominio → DNS → Import and Export e importa el archivo.</li><li>3. Deja los registros de correo en «DNS only» y pulsa comprobar.</li></ol>
        <p className="mb-4 text-xs text-subtle">El archivo conserva la web: no sustituye el A o CNAME del dominio raíz. Si ya hay registros MX o SPF, revísalos antes de importar y conserva un único SPF.</p>
        {report.warning && <div className="mb-4 rounded-lg border border-warn/30 p-3 text-sm text-warn"><p>{report.warning}</p><label className="mt-3 flex gap-2"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />He revisado el destino actual y el cambio de correo.</label></div>}
        {report.dnsUnknown && <p className="mb-3 text-sm text-warn">No se pudo consultar todo el DNS público. Comprueba los registros actuales en Cloudflare antes de importar.</p>}
        <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={!report.zone || (!!report.warning && !reviewed)} onClick={() => saveFile(`${domain}-mailway.txt`, report.zone!)}><Download size={14} /> Descargar DNS</Button>
          <Button loading={verify.isPending} onClick={() => verify.mutate()}>Comprobar conexión</Button></div>
        <div aria-live="polite" className="mt-5 space-y-2 text-sm text-sub">{report.checks?.filter(c => c.required).map(c => <div key={c.id} className="flex justify-between gap-3 border-b border-line py-2"><span>{c.label}</span><span>{({ ok: 'Publicado', missing: 'Pendiente', mismatch: 'Revisar', unknown: 'Sin respuesta' } as Record<string, string>)[c.status]}</span></div>)}
          <p>{report.webmailDetail || 'El webmail espera el DNS y el certificado HTTPS.'}</p></div>
        {report.webmailStatus === 'active' && <a className="mt-4 inline-flex items-center gap-2 text-sm text-acc-soft" href={report.webmailUrl} target="_blank" rel="noreferrer">Abrir webmail <ExternalLink size={14} /></a>}
        <p className="mt-4 text-xs text-subtle">Entra con la dirección completa y su contraseña. La comprobación DNS/HTTPS no prueba el inicio de sesión IMAP ni el envío de mensajes.</p>
      </>}
      {(provision.error || verify.error) && <p role="alert" className="mt-4 text-sm text-warn">{(provision.error || verify.error)?.message}</p>}
    </div>
  </div>;
}
