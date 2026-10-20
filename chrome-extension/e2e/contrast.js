// Rendered text contrast, shared by the appearance and style suites.
const assert = require("node:assert/strict");

// Composite transparent ancestor backgrounds before applying the WCAG formula.
// Canvas normalizes computed rgb(), rgba(), and color() syntax to sRGB bytes.
async function textContrast(page, selector) {
  return page.locator(selector).evaluateAll((elements) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    function rgba(value) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const bytes = [...context.getImageData(0, 0, 1, 1).data];
      return [bytes[0], bytes[1], bytes[2], bytes[3] / 255];
    }
    function over(front, back) {
      return front.slice(0, 3).map((component, i) => component * front[3] + back[i] * (1 - front[3]));
    }
    function luminance(color) {
      const linear = color.map((component) => {
        const value = component / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    return elements.filter((element) => element.getClientRects().length && element.textContent.trim()).map((element) => {
      const ancestors = [];
      for (let current = element; current; current = current.parentElement) ancestors.unshift(current);
      let background = [255, 255, 255];
      for (const ancestor of ancestors) background = over(rgba(getComputedStyle(ancestor).backgroundColor), background);
      const foreground = over(rgba(getComputedStyle(element).color), background);
      const light = luminance(foreground);
      const dark = luminance(background);
      return { text: element.textContent.trim().slice(0, 70), ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) };
    });
  });
}

async function assertReadable(page, selector) {
  const samples = await textContrast(page, selector);
  assert.ok(samples.length, `Expected visible text for ${selector}`);
  const failures = samples.filter(({ ratio }) => ratio < 4.5);
  assert.deepEqual(failures, [], `Text must meet 4.5:1 contrast: ${JSON.stringify(failures)}`);
}

module.exports = { textContrast, assertReadable };
