// A user's favourite sports / games — shown first in every sport picker.
import { z } from 'zod';
import { cap } from '../registry.js';
import { one, many } from '../db.js';
import { sportBySlugOrId } from '../helpers.js';
import { notFound } from '../errors.js';

const find = async (v) => (await sportBySlugOrId(v)) ?? Promise.reject(notFound('Sport'));

const TAG = 'Favourites & alerts';
const sport = z.string().min(1);

cap({
  name: 'favourite_sport', method: 'POST', path: '/sports/:sport/favourite', tag: TAG, auth: 'user', status: 201,
  summary: 'Mark a sport or game as a favourite (slug or id). Favourites are listed first in sport pickers.',
  input: z.object({ sport }),
  async handler({ user }, i) {
    const s = await find(i.sport);
    await one(
      `INSERT INTO favourite_sports(user_id, sport_id) VALUES ($1,$2)
       ON CONFLICT (user_id, sport_id) DO UPDATE SET removed_at = NULL RETURNING sport_id`, [user.id, s.id]);
    return { slug: s.slug, favourite: true };
  },
});

cap({
  name: 'unfavourite_sport', method: 'DELETE', path: '/sports/:sport/favourite', tag: TAG, auth: 'user', summary: 'Remove a sport from your favourites.',
  input: z.object({ sport }),
  async handler({ user }, i) {
    const s = await find(i.sport);
    await one('UPDATE favourite_sports SET removed_at = now() WHERE user_id=$1 AND sport_id=$2 AND removed_at IS NULL RETURNING sport_id', [user.id, s.id]);
    return { slug: s.slug, favourite: false };
  },
});

cap({
  name: 'list_favourite_sports', method: 'GET', path: '/me/favourite-sports', tag: TAG, auth: 'user', summary: 'Your favourite sports and games, most recently starred first.',
  input: z.object({}),
  handler: ({ user }) => many(
    `SELECT s.* FROM favourite_sports f JOIN sports s ON s.id = f.sport_id WHERE f.user_id = $1 AND f.removed_at IS NULL ORDER BY f.created_at DESC`, [user.id]),
});
