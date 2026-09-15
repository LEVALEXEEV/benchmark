/**
 * Визуальный отклик на клик в S4 — emissive-подсветка объекта.
 *
 * Цвет чередуется по порядковому номеру клика. Иначе повторный клик по уже
 * подсвеченному объекту выглядел бы как «отклик применён мгновенно», и
 * задержка в state-режиме занижалась бы: InputCollector определяет момент
 * отклика по фактическому цвету материала, а не по сигналу реализации.
 */
export const FEEDBACK_EMISSIVE_A = 0xffae00;
export const FEEDBACK_EMISSIVE_B = 0x00aeff;
export const FEEDBACK_EMISSIVE_OFF = 0x000000;

export function feedbackColorFor(clickSeq: number): number {
  return clickSeq % 2 === 1 ? FEEDBACK_EMISSIVE_A : FEEDBACK_EMISSIVE_B;
}
