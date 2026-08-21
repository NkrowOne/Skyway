import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api';
import { useToast } from './ui';

/**
 * Alta de la GitHub App del servidor.
 *
 * Vive aparte porque hacen falta dos sitios: el panel de Ajustes y el modal de
 * GitHub del proyecto. Antes solo estaba en Ajustes y desde el proyecto se
 * remitía con un enlace de texto —«créala en Ajustes → GitHub»—, que es donde
 * la gente se perdía: acababa en una página larga sin saber qué buscar y se
 * quedaba con los tokens, que era lo único que sí se veía.
 *
 * GitHub solo acepta el manifiesto por POST desde el navegador, así que se arma
 * un formulario al vuelo y se envía; no hay forma servidor-a-servidor.
 */
export function useCreateGithubApp() {
  const toast = useToast();
  // Se mantiene el estado de carga tras el éxito: la página está navegando a
  // github.com y el botón no debe volver a habilitarse por el camino.
  const [redirecting, setRedirecting] = useState(false);

  const mutation = useMutation({
    mutationFn: (org?: string) =>
      api.post<{ action: string; manifest: unknown }>('/github/app/manifest', org?.trim() ? { org: org.trim() } : {}),
    onSuccess: (res) => {
      setRedirecting(true);
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = res.action;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'manifest';
      input.value = JSON.stringify(res.manifest);
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    },
    onError: (err: Error) => toast(err.message, 'err'),
  });

  return {
    create: (org?: string) => mutation.mutate(org),
    pending: mutation.isPending || redirecting,
  };
}
