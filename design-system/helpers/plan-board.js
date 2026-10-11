(function (root) {
  const PLAN_COLUMNS = [
    { key: "backlog", label: "Backlog", accentVar: "--ds-faint" },
    { key: "drafting", label: "Current", accentVar: "--ds-info" },
    { key: "edits", label: "In Progress", accentVar: "--ds-unsaved" },
    { key: "review", label: "In Review", accentVar: "--ds-accent" },
    { key: "done", label: "Done", accentVar: "--ds-ident" }
  ];
  const PLAN_TAGS = {
    ch1: { label: "Act I", accentVar: "--ds-ident" },
    ch2: { label: "Act II", accentVar: "--ds-accent-fill" },
    ch3: { label: "Act III", accentVar: "--ds-info" },
    res: { label: "Research", accentVar: "--ds-unsaved" }
  };
  const PLAN_DEMO_CARDS = [
    { id:"p1",col:"backlog",ordinal:"9 / 12",title:"Tide-table research",excerpt:"Source notes for the dock scene; needs a continuity pass before drafting.",tag:"res",words:430,comments:0,unseen:0,threads:2,edited:"3d" },
    { id:"p2",col:"backlog",ordinal:"11 / 12",title:"Epilogue sketch",excerpt:"Loose notes toward a possible epilogue. Undecided whether to keep it.",tag:"ch3",words:210,comments:0,unseen:0,threads:0,edited:"5d" },
    { id:"p3",col:"drafting",ordinal:"4 / 12",title:"Complication at the dock",excerpt:"The harbor scene where the recovered note reframes chapter one.",tag:"ch2",due:"Jun 7",urgency:"soon",urgencyLabel:"Due soon",words:2140,comments:1,unseen:0,threads:1,edited:"2h" },
    { id:"p4",col:"drafting",ordinal:"6 / 12",title:"The argument turns",excerpt:"Two characters reverse positions; the reader should feel the ground move.",tag:"ch2",words:1610,comments:0,unseen:0,threads:0,edited:"6h" },
    { id:"p5",col:"edits",ordinal:"2 / 12",title:"Why the room is empty",excerpt:"Establish the narrator and the unfinished letter on the desk.",tag:"ch1",due:"Jun 14",urgency:"future",urgencyLabel:"Due",words:1502,comments:3,unseen:1,threads:0,edited:"1d" },
    { id:"p6",col:"edits",ordinal:"7 / 12",title:"Letter, in full",excerpt:"The recovered letter shown complete for the first time.",tag:"ch2",words:880,comments:2,unseen:0,threads:0,edited:"4h" },
    { id:"p7",col:"review",ordinal:"1 / 12",title:"Opening image",excerpt:"Cold open on the empty room; sets tone and the central question.",tag:"ch1",due:"Jun 21",urgency:"future",urgencyLabel:"Due",words:980,comments:1,unseen:0,threads:0,edited:"1d" },
    { id:"p8",col:"review",ordinal:"5 / 12",title:"Recovered note",excerpt:"Short bridging scene carrying the note from the dock forward.",tag:"ch2",words:640,comments:0,unseen:0,threads:1,edited:"8h" },
    { id:"p9",col:"done",ordinal:"3 / 12",title:"Section-grain edits",excerpt:"Each node is one file; reordering nodes reorders the document.",tag:"ch1",due:"Jun 1",urgency:"late",urgencyLabel:"Overdue",words:1284,comments:0,unseen:0,threads:0,edited:"2d" },
    { id:"p10",col:"done",ordinal:"12 / 12",title:"Resolution beat",excerpt:"Resolves the letter without closing every open question.",tag:"ch3",words:1190,comments:0,unseen:0,threads:0,edited:"2d" }
  ];
  function cardsInColumn(cards, col) { return cards.filter((c) => c.col === col); }
  function moveCard(cards, id, col, beforeId) {
    const i = cards.findIndex((c) => c.id === id); if (i < 0) return cards;
    const next = cards.slice(), moved = next.splice(i, 1)[0], placed = Object.assign({}, moved, { col });
    if (beforeId && beforeId !== id) { const j = next.findIndex((c) => c.id === beforeId); if (j >= 0) { next.splice(j, 0, placed); return next; } }
    let last = -1; next.forEach((c, idx) => { if (c.col === col) last = idx; });
    if (last === -1) next.push(placed); else next.splice(last + 1, 0, placed); return next;
  }
  function planReducer(state, action) {
    switch (action.type) {
      case "move": { const cards = moveCard(state.cards, action.id, action.col, action.beforeId); return cards === state.cards ? state : Object.assign({}, state, { cards, focusId: action.id }); }
      case "shiftColumn": { const card = state.cards.find((c) => c.id === action.id); if (!card) return state; const i = PLAN_COLUMNS.findIndex((c) => c.key === card.col), ni = i + action.dir; if (ni < 0 || ni >= PLAN_COLUMNS.length) return state; return Object.assign({}, state, { cards: moveCard(state.cards, action.id, PLAN_COLUMNS[ni].key, null), focusId: action.id }); }
      case "shiftRank": { const card = state.cards.find((c) => c.id === action.id); if (!card) return state; const col = cardsInColumn(state.cards, card.col), pos = col.indexOf(card), np = pos + action.dir; if (np < 0 || np >= col.length) return state; const before = action.dir === 1 ? col[np + 1] : col[np]; return Object.assign({}, state, { cards: moveCard(state.cards, action.id, card.col, before ? before.id : null), focusId: action.id }); }
      case "dragStart": return Object.assign({}, state, { dragId: action.id });
      case "dragOver": return Object.assign({}, state, { overCol: action.col, insertBeforeId: action.beforeId });
      case "drop": { const cleared = { dragId: null, overCol: null, insertBeforeId: null }; if (!state.dragId || !state.overCol) return Object.assign({}, state, cleared); return Object.assign({}, state, cleared, { cards: moveCard(state.cards, state.dragId, state.overCol, state.insertBeforeId) }); }
      case "dragEnd": return Object.assign({}, state, { dragId: null, overCol: null, insertBeforeId: null });
      case "focus": return Object.assign({}, state, { focusId: action.id });
      default: return state;
    }
  }
  root.DSHelpers = Object.assign(root.DSHelpers || {}, { PLAN_COLUMNS, PLAN_TAGS, PLAN_DEMO_CARDS, cardsInColumn, moveCard, planReducer });
})(globalThis);
