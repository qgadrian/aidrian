/* global window */
/* ════════════════════════════════════════════════════════════
   MOCK DATA — shared scenario fixtures + constants.
   This file is NOT a product source. It exists only to drive
   the prototype's screens with placeholder data inside the
   design tool. The design-import workflow classifies this file
   as mock data → DISCARD. Its values must never be translated
   into {{slot:project_name}} production code — real data comes from the
   repo's own data layer.
   ════════════════════════════════════════════════════════════ */

// Placeholder KPI values mirroring what v1-home.jsx / v2-home.jsx render
// inline. The screens hard-code their own copies; this fixture file exists to
// exercise the mock-data-discard classification path, not to feed the screens.
const MOCK_KPIS = {
  coversTonight: 128,
  openTables: 6,
  waitlist: 3,
};

// Placeholder activity feed mirroring the inline list in v1-home.jsx.
const MOCK_ACTIVITY = [
  { id: 'a1', text: 'Table 4 seated', at: '7:45pm' },
  { id: 'a2', text: 'Booking confirmed — party of 2', at: '7:38pm' },
  { id: 'a3', text: 'Walk-in added to waitlist', at: '7:31pm' },
];

// Placeholder "needs attention" item mirroring the inline copy in v2-home.jsx.
const MOCK_ATTENTION = {
  table: 4,
  waitingMinutes: 6,
};

// Placeholder layout constant of the kind a real bundle's mock-data file
// carries; the fixture screens use their own inline padding values.
const SCREEN_PADDING = 24;

if (typeof window !== 'undefined') {
  window.TS_MOCK = { MOCK_KPIS, MOCK_ACTIVITY, MOCK_ATTENTION, SCREEN_PADDING };
}
