// "Sign in to do X": a visitor taps Apply / Contact / Profile on a public card. We remember what they wanted, send them
// through the login flow, and pick it up again once they are signed in.
let pending = null;
export const setIntent = (i) => { pending = i; };
export const peekIntent = () => pending;
export const takeIntent = () => { const i = pending; pending = null; return i; };

export const INTENT_COPY = {
  apply: ['Sign in to apply', 'Create a free account or log in. We will bring you straight back to this opportunity.'],
  contact: ['Sign in to contact', 'Contact details and messages are for members only.'],
  profile: ['Sign in to view profiles', 'Athlete, team and organizer profiles are visible to members.'],
  react: ['Sign in to join the conversation', 'Like and comment once you are in.'],
  post: ['Sign in to post', 'Share a wanted ad, match, schedule, sale or campaign with the arena.'],
  advertise: ['Sign in to advertise', 'Submit a campaign for review and reach the whole arena.'],
  join: ['Join the arena', 'One account for athletes, coaches, organizers, venues and sponsors.'],
};
