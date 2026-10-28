/* global React */
/* ════════════════════════════════════════════════════════════
   EDITOR HARNESS — tweaks panel.
   This file is NOT a product screen. It renders the design
   tool's scenario / theme tweak controls so the prototype can
   be explored interactively. The design-import workflow
   classifies this file as harness → DISCARD. It must never be
   translated into the consuming project production code.
   ════════════════════════════════════════════════════════════ */

const { useState } = React;

function TweaksPanel({ title, children }) {
  return (
    <aside style={{
      position: 'fixed', right: 0, top: 0, width: 260, height: '100%',
      background: '#fff', borderLeft: '1px solid var(--border-c)', padding: 16,
      fontFamily: 'var(--font-sans)', fontSize: 13,
    }}>
      <strong>{title}</strong>
      <div style={{ marginTop: 12 }}>{children}</div>
    </aside>
  );
}

function TweakSelect({ label, value, options, onChange }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span className="small">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%' }}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function TweaksPanelDemo() {
  const [generation, setGeneration] = useState('v2');
  return (
    <TweaksPanel title="Tweaks · fixture">
      <TweakSelect
        label="Generation"
        value={generation}
        options={[
          { value: 'v1', label: 'V1 — KPI grid' },
          { value: 'v2', label: 'V2 — attention-first' },
        ]}
        onChange={setGeneration}
      />
    </TweaksPanel>
  );
}
