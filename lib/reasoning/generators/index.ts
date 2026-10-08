import type { Family, Generator } from '../types';
import { numberSeries } from './numberSeries';
import { dataInterp } from './dataInterp';
import { deduction } from './deduction';
import { letterSeries } from './letterSeries';
import { verbal } from './verbal';
import { wordProblem } from './wordProblem';

export const GENERATORS: Record<Family, Generator> = {
  number_series: numberSeries,
  data_interp: dataInterp,
  deduction,
  letter_series: letterSeries,
  verbal,
  word_problem: wordProblem,
};

export { numberSeries, dataInterp, deduction, letterSeries, verbal, wordProblem };
