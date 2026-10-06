import type { ReactNode } from 'react';
import { BRAND } from '../../brand.ts';
import { Logo } from '../Logo.tsx';
import { LoginArt } from './LoginArt.tsx';

const BULLETS = [
  'Every question reaches you with context',
  'Nothing leaves without your approval',
  'Your machines, your repos, your vaults',
];

/** Sign-in frame: the always-dark brand panel (side on desktop, band above on tablet and phone) and the form column. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas lg:flex-row">
      <aside className="relative isolate flex shrink-0 flex-col justify-between overflow-hidden bg-side px-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-8 text-white max-lg:h-44 max-lg:rounded-b-[24px] max-sm:h-40 sm:max-lg:h-56 lg:w-[55%] lg:p-10">
        <LoginArt className="absolute inset-0 -z-10 opacity-90" />
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,#0D1220_8%,transparent_62%)] max-lg:bg-[linear-gradient(to_top,#0D1220_2%,transparent_70%)]"
        />
        <Logo variant="dark" height={32} />
        <div className="max-w-[28ch] space-y-4 lg:max-w-md">
          <p className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl lg:text-4xl">
            {BRAND.slogan}
          </p>
          <p className="hidden text-base text-[#b4bdd0] lg:block">{BRAND.descriptor}</p>
          <ul className="hidden space-y-2 text-sm text-[#b4bdd0] lg:block">
            {BULLETS.map((b) => (
              <li key={b} className="flex items-center gap-2.5">
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />
                {b}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-8 pb-[max(2rem,env(safe-area-inset-bottom))] max-lg:-mt-2">
        <div className="w-full max-w-sm">{children}</div>
        <p className="mt-10 text-xs text-subtle">Self-hosted · your data stays on your machines</p>
      </main>
    </div>
  );
}
