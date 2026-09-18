// 精确十进制运算：重量与金额一律用 BigInt 定点数表示，
// 杜绝 weightKg * centsPerKg 的二进制浮点漂移。
// 一个值记为 scaled / 10^scale。

const DECIMAL_RE = /^(-?)(?:(\d+)(?:\.(\d+))?|\.(\d+))$/;

/**
 * 把数字或字符串解析为定点十进制，保留输入声明的全部小数位（规定精度）。
 * @param {number|string|bigint} value
 * @returns {{scaled: bigint, scale: number}}
 */
export function parseDecimal(value) {
  if (typeof value === 'bigint') return { scaled: value, scale: 0 };
  const s = String(value).trim();
  const m = DECIMAL_RE.exec(s);
  if (!m) {
    throw new Error(`无法解析的十进制数值: ${s}`);
  }
  const [, sign, intPart, fracPart1, fracPart2] = m;
  const intDigits = intPart ?? '0';
  const fracDigits = fracPart1 ?? fracPart2 ?? '';
  const scaled = BigInt(`${sign === '-' ? '-' : ''}${intDigits}${fracDigits}`);
  return { scaled, scale: fracDigits.length };
}

/** 定点数转十进制字符串（金额展示用，去掉末尾多余的 0）。 */
export function formatScaled(scaled, scale) {
  if (scale === 0) return scaled.toString();
  const negative = scaled < 0n;
  let digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  let fracPart = digits.slice(digits.length - scale).replace(/0+$/, '');
  let out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${out}` : out;
}

/**
 * 把 scaled / 10^scale 按四舍五入（半数取绝对值更大的一侧）取整为整数分。
 * 只允许在批次末尾调用一次。
 */
export function roundHalfUp(scaled, scale) {
  if (scale === 0) return scaled;
  const base = 10n ** BigInt(scale);
  if (scaled >= 0n) return (scaled * 2n + base) / (2n * base);
  return -((-scaled * 2n + base) / (2n * base));
}

/** 同精度/异精度定点数求和，返回两者中更大的精度。 */
export function addScaled(a, b) {
  const scale = Math.max(a.scale, b.scale);
  const av = a.scaled * 10n ** BigInt(scale - a.scale);
  const bv = b.scaled * 10n ** BigInt(scale - b.scale);
  return { scaled: av + bv, scale };
}
