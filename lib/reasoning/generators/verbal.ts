import type { Generator } from '../types';
import { createRng, type Rng } from '../rng';
import { buildOptions } from '../options';
import { capitalise, NAMES } from '../format';

// Parametric verbal items. There is deliberately no fixed question bank with fixed answers:
// analogies are assembled at random from word pairs, and the logic items randomise the rule,
// the person and the form of argument. Words are everyday, sentences are short.

export type RelationName = 'opposite' | 'category_member' | 'part_whole' | 'tool_use' | 'maker_product' | 'degree';

export interface Relation {
  tier: 'easy' | 'medium';
  /** How the link reads, for admin review. */
  label: string;
  /** [A, B] or [A, B, lure]. The lure is linked to A by a *different* relation (medium tier distractor). */
  pairs: readonly (readonly [string, string] | readonly [string, string, string])[];
  /** [A, word]: word should never be offered as a distractor for A because it could be argued correct. */
  conflicts?: readonly (readonly [string, string])[];
}

export const RELATIONS: Record<RelationName, Relation> = {
  opposite: {
    tier: 'easy',
    label: 'opposites',
    pairs: [
      ['hot', 'cold'], ['full', 'empty'], ['fast', 'slow'], ['light', 'dark'], ['open', 'closed'],
      ['early', 'late'], ['high', 'low'], ['buy', 'sell'], ['push', 'pull'], ['win', 'lose'],
      ['wet', 'dry'], ['rich', 'poor'], ['clean', 'dirty'], ['loud', 'quiet'], ['strong', 'weak'],
      ['thick', 'thin'], ['first', 'last'], ['day', 'night'], ['inside', 'outside'], ['young', 'old'],
      ['happy', 'sad'], ['remember', 'forget'], ['question', 'answer'],
    ],
  },
  category_member: {
    tier: 'easy',
    label: 'group and member',
    pairs: [
      ['fruit', 'mango'], ['vegetable', 'carrot'], ['colour', 'blue'], ['bird', 'eagle'], ['fish', 'tuna'],
      ['insect', 'ant'], ['furniture', 'chair'], ['vehicle', 'bus'], ['sport', 'soccer'], ['drink', 'tea'],
      ['clothing', 'jacket'], ['instrument', 'drum'], ['shape', 'circle'], ['month', 'June'], ['planet', 'Mars'],
      ['flower', 'rose'], ['metal', 'iron'], ['number', 'seven'], ['country', 'Kenya'],
    ],
  },
  part_whole: {
    tier: 'medium',
    label: 'part and whole',
    pairs: [
      ['page', 'book', 'paper'], ['wheel', 'car', 'tyre'], ['petal', 'flower', 'stem'], ['finger', 'hand', 'nail'],
      ['toe', 'foot', 'shoe'], ['branch', 'tree', 'leaf'], ['brick', 'wall', 'clay'], ['feather', 'bird', 'soft'],
      ['room', 'house', 'door'], ['string', 'guitar', 'music'], ['word', 'sentence', 'letter'], ['player', 'team', 'ball'],
      ['sleeve', 'shirt', 'arm'], ['yolk', 'egg', 'yellow'], ['link', 'chain', 'metal'], ['sail', 'boat', 'wind'],
      ['step', 'stairs', 'climb'], ['lid', 'jar', 'open'],
    ],
    conflicts: [['brick', 'house'], ['step', 'house'], ['word', 'book'], ['petal', 'tree'], ['brick', 'stairs'], ['page', 'sentence']],
  },
  tool_use: {
    tier: 'medium',
    label: 'tool and what it is used for',
    pairs: [
      ['knife', 'cut', 'fork'], ['pen', 'write', 'paper'], ['broom', 'sweep', 'floor'], ['spade', 'dig', 'garden'],
      ['needle', 'sew', 'thread'], ['key', 'unlock', 'door'], ['oven', 'bake', 'hot'], ['kettle', 'boil', 'water'],
      ['ladder', 'climb', 'high'], ['ruler', 'measure', 'straight'], ['soap', 'wash', 'bubbles'], ['towel', 'dry', 'bath'],
      ['phone', 'call', 'number'], ['glue', 'stick', 'bottle'], ['net', 'catch', 'fish'], ['fridge', 'cool', 'food'],
    ],
    conflicts: [['phone', 'write'], ['towel', 'wash'], ['spade', 'cut'], ['knife', 'dig'], ['soap', 'clean'], ['fridge', 'dry']],
  },
  maker_product: {
    tier: 'medium',
    label: 'maker and what they make',
    pairs: [
      ['baker', 'bread', 'oven'], ['author', 'book', 'reader'], ['tailor', 'suit', 'needle'], ['carpenter', 'furniture', 'wood'],
      ['singer', 'song', 'stage'], ['painter', 'painting', 'brush'], ['builder', 'house', 'brick'], ['chef', 'meal', 'kitchen'],
      ['photographer', 'photo', 'camera'], ['shoemaker', 'shoes', 'feet'], ['bee', 'honey', 'flower'], ['spider', 'web', 'fly'],
      ['hen', 'egg', 'farm'], ['cow', 'milk', 'grass'], ['sheep', 'wool', 'field'], ['jeweller', 'ring', 'gold'],
    ],
    conflicts: [['chef', 'bread'], ['baker', 'meal'], ['carpenter', 'house'], ['builder', 'furniture']],
  },
  degree: {
    tier: 'medium',
    label: 'milder and stronger form',
    pairs: [
      ['warm', 'hot', 'cold'], ['cool', 'cold', 'hot'], ['damp', 'wet', 'dry'], ['tired', 'exhausted', 'sleep'],
      ['big', 'huge', 'small'], ['small', 'tiny', 'big'], ['hungry', 'starving', 'food'], ['angry', 'furious', 'calm'],
      ['like', 'love', 'hate'], ['whisper', 'shout', 'quiet'], ['good', 'excellent', 'bad'], ['bad', 'terrible', 'good'],
      ['scared', 'terrified', 'brave'], ['dirty', 'filthy', 'clean'], ['hill', 'mountain', 'valley'], ['stream', 'river', 'bridge'],
    ],
  },
};

const RELATIONS_BY_TIER: Record<'easy' | 'medium', RelationName[]> = {
  easy: ['opposite', 'category_member'],
  medium: ['part_whole', 'tool_use', 'maker_product', 'degree'],
};

/** True when `word` could be argued to stand in relation `rel` to `a` (bank pair or listed conflict). */
export function isValidCompletion(rel: RelationName, a: string, word: string): boolean {
  const r = RELATIONS[rel];
  return r.pairs.some((p) => p[0] === a && p[1] === word) || (r.conflicts ?? []).some(([x, y]) => x === a && y === word);
}

function analogy(rng: Rng, tier: 'easy' | 'medium') {
  const relName = rng.pick(RELATIONS_BY_TIER[tier]);
  const rel = RELATIONS[relName];
  const [first, second, ...others] = rng.shuffle(rel.pairs);
  const [a, b] = first!;
  const [c, d, lure] = second!;
  const otherB = others.map((p) => p[1]);
  const otherA = others.map((p) => p[0]);
  const candidates =
    tier === 'easy'
      ? [b, otherB[0], otherA[0], otherB[1], otherB[2], otherA[1]] // same-group words that do not fit
      : [lure, b, otherB[0], otherB[1], otherB[2], otherB[3]]; // near-miss associate, stem repeat, same-group words
  const distractors = candidates.filter((w): w is string => !!w && w !== c && !isValidCompletion(relName, c, w));
  const pool = otherB.filter((w) => w !== c && !isValidCompletion(relName, c, w));
  return {
    prompt: `${capitalise(a)} is to ${b} as ${c} is to ?`,
    answer: d,
    distractors,
    fallback: () => rng.pick(pool),
    meta: { kind: 'analogy', relation: relName, a, b, c, d },
  };
}

// ---------- hard: conditional logic ----------

export type ConditionalForm = 'modus_ponens' | 'modus_tollens' | 'affirming_consequent' | 'denying_antecedent';

export const CANNOT_TELL = 'Cannot be determined from the information given.';

interface RuleTemplate {
  rule: string;
  p: string; // "{x}" is replaced by a name
  notP: string;
  q: string;
  notQ: string;
  converse: string; // a tempting statement that does NOT follow
}

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  { rule: 'If a contract is renewed, a welcome SMS is sent.', p: "{x}'s contract was renewed.", notP: "{x}'s contract was not renewed.", q: 'A welcome SMS was sent to {x}.', notQ: 'No welcome SMS was sent to {x}.', converse: 'Everyone who got a welcome SMS renewed a contract.' },
  { rule: 'If a client pays late, a R50 fee is added.', p: '{x} paid late.', notP: '{x} did not pay late.', q: "A R50 fee was added to {x}'s account.", notQ: "No R50 fee was added to {x}'s account.", converse: 'Everyone who was charged R50 paid late.' },
  { rule: 'If an agent works on Saturday, they get Monday off.', p: '{x} worked on Saturday.', notP: '{x} did not work on Saturday.', q: '{x} got Monday off.', notQ: '{x} did not get Monday off.', converse: 'Everyone who got Monday off worked on Saturday.' },
  { rule: 'If a password is entered wrongly three times, the account is locked.', p: '{x} entered a wrong password three times.', notP: '{x} did not enter a wrong password three times.', q: "{x}'s account was locked.", notQ: "{x}'s account was not locked.", converse: 'Every locked account had three wrong passwords.' },
  { rule: 'If a staff member finishes the course, they get a certificate.', p: '{x} finished the course.', notP: '{x} did not finish the course.', q: '{x} got a certificate.', notQ: '{x} did not get a certificate.', converse: 'Everyone with a certificate finished the course.' },
  { rule: 'If a customer spends over R500, delivery is free.', p: '{x} spent over R500.', notP: '{x} did not spend over R500.', q: "{x}'s delivery was free.", notQ: "{x}'s delivery was not free.", converse: 'Everyone with free delivery spent over R500.' },
  { rule: 'If a driver goes over the speed limit, they get a fine.', p: '{x} went over the speed limit.', notP: '{x} did not go over the speed limit.', q: '{x} got a fine.', notQ: '{x} did not get a fine.', converse: 'Everyone who got a fine went over the speed limit.' },
  { rule: 'If a form is incomplete, it is sent back.', p: "{x}'s form was incomplete.", notP: "{x}'s form was complete.", q: "{x}'s form was sent back.", notQ: "{x}'s form was not sent back.", converse: 'Every form that was sent back was incomplete.' },
  { rule: 'If a team meets its target, it gets a bonus.', p: "{x}'s team met its target.", notP: "{x}'s team did not meet its target.", q: "{x}'s team got a bonus.", notQ: "{x}'s team did not get a bonus.", converse: 'Every team that got a bonus met its target.' },
  { rule: 'If a parcel weighs more than 5 kg, it goes by road.', p: "{x}'s parcel weighed more than 5 kg.", notP: "{x}'s parcel did not weigh more than 5 kg.", q: "{x}'s parcel went by road.", notQ: "{x}'s parcel did not go by road.", converse: 'Every parcel that went by road weighed more than 5 kg.' },
  { rule: 'If a meeting runs late, the next one is cancelled.', p: "{x}'s first meeting ran late.", notP: "{x}'s first meeting did not run late.", q: "{x}'s next meeting was cancelled.", notQ: "{x}'s next meeting was not cancelled.", converse: 'Every cancelled meeting came after one that ran late.' },
];

function conditional(rng: Rng) {
  const tpl = rng.pick(RULE_TEMPLATES);
  const x = rng.pick(NAMES);
  const s = {
    p: tpl.p.replace('{x}', x),
    notP: tpl.notP.replace('{x}', x),
    q: tpl.q.replace('{x}', x),
    notQ: tpl.notQ.replace('{x}', x),
  };
  const form = rng.pick(['modus_ponens', 'modus_tollens', 'affirming_consequent', 'denying_antecedent'] as const);
  // fact given -> correct answer; the other options never repeat the fact itself.
  const plan: Record<ConditionalForm, { fact: string; answer: string; others: string[] }> = {
    modus_ponens: { fact: s.p, answer: s.q, others: [s.notQ, CANNOT_TELL, s.notP, tpl.converse] },
    modus_tollens: { fact: s.notQ, answer: s.notP, others: [s.p, CANNOT_TELL, s.q, tpl.converse] },
    affirming_consequent: { fact: s.q, answer: CANNOT_TELL, others: [s.p, s.notP, s.notQ, tpl.converse] },
    denying_antecedent: { fact: s.notP, answer: CANNOT_TELL, others: [s.notQ, s.q, s.p, tpl.converse] },
  };
  const { fact, answer, others } = plan[form];
  return {
    prompt: `${tpl.rule}\n${fact}\nWhich of these must be true?`,
    answer,
    distractors: others,
    fallback: () => answer, // never needed: there are always 4 others
    meta: { kind: 'conditional', form, fact, statements: { ...s, converse: tpl.converse } },
  };
}

export const verbal: Generator = (seed, tier) => {
  const rng = createRng(seed);
  const built = tier === 'hard' ? conditional(rng) : analogy(rng, tier);
  const { options, answerIndex } = buildOptions(rng, built.answer, built.distractors, built.fallback);
  return { family: 'verbal', tier, stem: { prompt: built.prompt }, options, answerIndex, meta: built.meta };
};
