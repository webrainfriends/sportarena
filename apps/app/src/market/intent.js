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
  book: ['Sign in to book this venue', 'Create a free account or log in. We will take you straight to the booking with your court and date ready.'],
  apply_position: ['Sign in to apply', 'Create a free account or log in. We will bring you straight back to this position so you can apply and share your documents.'],
  sponsor: ['Sign in to approach this sponsor', 'Create a free account or log in to apply for sponsorship, for yourself, your team or your event.'],
  provider: ['Sign in to book a physio or doctor', 'Create a free account or log in. Your health information stays private and is shared only with your consent.'],
  coach: ['Sign in to book a coach', 'Create a free account or log in to see open slots and book a session.'],
  study: ['Sign in to ask about a course', 'Create a free account or log in to contact the institution and save courses you like.'],
  join: ['Join the arena', 'One account for athletes, coaches, organizers, venues and sponsors.'],
};
