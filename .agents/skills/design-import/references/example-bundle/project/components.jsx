/* global React */
/* Shared UI primitives for the Example Home fixture.
   In a real bundle this file is larger; the fixture keeps three
   primitives so the workflow can map them to the project design system / src/core/ui. */

const { useState } = React;

// ===== Icon =====
const iconPaths = {
  plus:  'M12 4.5v15m7.5-7.5h-15',
  bell:  'M14.857 17.082a23.85 23.85 0 005.454-1.31A8.97 8.97 0 0118 9.75V9A6 6 0 006 9v.75a8.97 8.97 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.26 24.26 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0',
  check: 'M4.5 12.75l6 6 9-13.5',
};

function Icon({ name, size = 18, stroke = 1.5 }) {
  return React.createElement('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { width: size, height: size, display: 'inline-block', verticalAlign: '-0.125em' },
  }, React.createElement('path', { d: iconPaths[name] }));
}

// ===== Button =====
function Button({ variant = 'default', onClick, children }) {
  const base = {
    fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: 14,
    borderRadius: 'var(--radius)', padding: '8px 14px', cursor: 'pointer',
    border: '1px solid transparent', transition: 'background var(--dur-base) var(--ease)',
  };
  const variants = {
    default: { background: 'var(--brand-green)', color: 'var(--brand-charcoal)' },
    ghost:   { background: 'transparent', color: 'var(--fg)', borderColor: 'var(--border-c)' },
  };
  return React.createElement('button', {
    type: 'button', onClick, style: { ...base, ...(variants[variant] || variants.default) },
  }, children);
}

// ===== Card =====
function Card({ title, children }) {
  return (
    <section style={{
      background: 'var(--surface)', border: '1px solid var(--border-c)',
      borderRadius: 'var(--radius)', padding: 16,
    }}>
      {title ? <h2 style={{ margin: '0 0 8px' }}>{title}</h2> : null}
      {children}
    </section>
  );
}
