// The front desk's calendar: every slot, free or taken, for today. A slot is free or taken: there is no held state.
export function today(slots) {
  return slots.map(({ time, booking }) => ({ time, state: booking ? 'taken' : 'free' }));
}
