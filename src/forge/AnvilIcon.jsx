// The Forge tab glyph: an anvil. Not in lucide or tabler's vocabularies, so it is ours —
// drawn on tabler's 24 grid with the same stroke conventions (stroke=2, round joins, currentColor).
import React from 'react';
export function AnvilIcon({size=24, stroke=2, ...rest}){
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    <path d="M3 9l3-3h9a3.2 3.2 0 0 1 3.2 3.2c0 1.6-1.3 2.8-3.2 2.8H8z"/>
    <path d="M9.5 12l-1 4h-3v3h13v-3h-3l-1-4"/>
  </svg>;
}
