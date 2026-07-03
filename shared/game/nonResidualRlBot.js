import { heuristicQuetschPick } from './heuristicBot.js';
import { chooseRlCardFromModel } from './rlBot.js';
import { NON_RESIDUAL_RL_POLICY } from './nonResidualRlPolicyData.js';

export const chooseNonResidualRlCard = (gs, player) =>
  chooseRlCardFromModel(gs, player, { model: NON_RESIDUAL_RL_POLICY });

export const nonResidualRlQuetschPick = heuristicQuetschPick;
