import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../api/client.ts';
import { useInvalidatePushDevices, usePushConfig } from '../api/queries/push.ts';
import { currentEndpoint, enablePush, type PushSupport, pushSupport } from '../lib/push.ts';

export interface PushSubscriptionState {
  /** Server has push keys (`GET /api/push/config`); null while loading. */
  serverEnabled: boolean | null;
  publicKey: string | undefined;
  support: PushSupport;
  /** Endpoint of this browser's subscription, null when there is none (or not known yet, see `checked`). */
  here: string | null;
  /** `here` has been looked up at least once. */
  checked: boolean;
  busy: boolean;
  problem: string | null;
  /** Ask for permission and subscribe. Call it straight from a click handler. Resolves true on success. */
  enable: () => Promise<boolean>;
  /** Re-read this device's endpoint (after removing it, say). */
  refresh: () => Promise<void>;
}

/** The one enable-notifications flow, shared by Settings and the first-run prompt. */
export function usePushSubscription(): PushSubscriptionState {
  const config = usePushConfig();
  const refreshDevices = useInvalidatePushDevices();
  const [here, setHere] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [support, setSupport] = useState<PushSupport>(pushSupport);

  const refresh = useCallback(async () => {
    setHere(await currentEndpoint());
    setChecked(true);
    setSupport(pushSupport());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const publicKey = config.data?.publicKey;
  const enable = async (): Promise<boolean> => {
    if (!publicKey) return false;
    setBusy(true);
    setProblem(null);
    try {
      await enablePush(publicKey);
      await refresh();
      await refreshDevices();
      return true;
    } catch (e) {
      setProblem(errorMessage(e));
      setSupport(pushSupport());
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    serverEnabled: config.data ? config.data.enabled === true : null,
    publicKey,
    support,
    here,
    checked,
    busy,
    problem,
    enable,
    refresh,
  };
}
