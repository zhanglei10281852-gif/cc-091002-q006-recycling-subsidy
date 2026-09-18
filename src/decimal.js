// 定点十进制工具：重量与金额在内部一律用整数表示，避免浮点漂移。
// 重量以 milli-kg（0.001 kg，规定精度）计，费率以 milli-cent/kg 计，
// 金额以 micro-cent（1e-6 分）计，恰好是 milli-kg × milli-cent 的量纲。

export const WEIGHT_SCALE = 3; // 重量规定精度：0.001 kg
export const RATE_SCALE = 3; // 费率精度：0.001 分/kg
export const MONEY_SCALE = 6; // 金额精度：1e-6 分（= WEIGHT_SCALE + RATE_SCALE）
export const MICRO_CENTS_PER_CENT = 1_000_000;

const DECIMAL_RE = /^([+-]?)(\d+)?(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

// 把 number 或十进制字符串解析为 round(value × 10^scale) 的整数。
// 四舍五入按绝对值远离零方向；解析基于十进制文本而非二进制浮点，
// 因此 2.675、0.0005 这类边界值不会出现浮点漂移。
export function parseScaledInt(value, scale, name = 'value') {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError(`${name} must be a number or decimal string, got ${typeof value}`);
  }
  const text = String(value).trim();
  const match = DECIMAL_RE.exec(text);
  if (!match || (match[2] === undefined && match[3] === undefined)) {
    throw new Error(`${name} is not a valid decimal: ${text}`);
  }
  const negative = match[1] === '-';
  const frac = match[3] ?? '';
  const digits = BigInt((match[2] ?? '') + frac || '0');
  const exponent = BigInt((match[4] ?? '0').replace(/^\+/, '')) - BigInt(frac.length) + BigInt(scale);
  let scaled;
  if (exponent >= 0n) {
    scaled = digits * 10n ** exponent;
  } else {
    const divisor = 10n ** -exponent;
    const quotient = digits / divisor;
    const remainder = digits - quotient * divisor;
    scaled = remainder * 2n >= divisor ? quotient + 1n : quotient;
  }
  const signed = negative ? -scaled : scaled;
  if (signed > MAX_SAFE || signed < -MAX_SAFE) {
    throw new Error(`${name} exceeds the safe integer range: ${text}`);
  }
  return Number(signed);
}

// 整数除法的四舍五入（按绝对值远离零方向），用于批次末尾对总额统一舍入。
export function roundDiv(numerator, denominator) {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new TypeError('roundDiv expects safe integers with a positive denominator');
  }
  const negative = numerator < 0;
  const abs = Math.abs(numerator);
  const quotient = Math.floor(abs / denominator);
  const rounded = (abs - quotient * denominator) * 2 >= denominator ? quotient + 1 : quotient;
  return negative ? -rounded : rounded;
}
