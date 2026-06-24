'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Renders a QR code for an otpauth:// URI so a phone authenticator (Google
 * Authenticator, Authy, ...) can scan it. Generated entirely in the browser -
 * the TOTP secret never leaves the device.
 */
export function QrCode({ value, size = 180 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(value, { width: size, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (active) setDataUrl(url); })
      .catch(() => { if (active) setDataUrl(null); });
    return () => { active = false; };
  }, [value, size]);

  if (!dataUrl) {
    return (
      <div
        className="animate-pulse rounded-lg bg-neutral-200 dark:bg-neutral-700"
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- data URL, no remote optimization
    <img
      src={dataUrl}
      alt="Two-factor authentication QR code"
      width={size}
      height={size}
      className="rounded-lg bg-white p-2 shadow-sm"
    />
  );
}
