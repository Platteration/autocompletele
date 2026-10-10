// The original letters stay in place in the word: a[uto]c[omple]t[e]le.
// Play once per opened page; replay is an explicit button action.
(function () {
  "use strict";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const pieces = [
    ["a"], ["uto", "prefix"], ["c"], ["omple", "middle"],
    ["t"], ["e", "suffix"], ["le"],
  ];

  for (const button of document.querySelectorAll("[data-actle-brand]")) {
    const word = button.querySelector(".actle-brand__word");
    if (!word) continue;

    word.replaceChildren(...pieces.map(([text, completion]) => {
      const span = document.createElement("span");
      span.textContent = text;
      if (completion) {
        span.className = `actle-brand__completion actle-brand__completion--${completion}`;
      }
      return span;
    }));

    function stop() {
      button.dataset.actleState = "idle";
    }

    function play() {
      stop();
      if (reducedMotion.matches) return;
      // Flush the resting state so an explicit replay also restarts a running
      // animation. Its reserved width means this does not move other controls.
      void word.offsetWidth;
      button.dataset.actleState = "playing";
    }

    function syncMotionPreference() {
      button.setAttribute("aria-disabled", String(reducedMotion.matches));
      button.setAttribute("aria-label", reducedMotion.matches
        ? "actle — autocompletes to autocompletele"
        : "actle — autocompletes to autocompletele. Replay logo animation");
      button.title = reducedMotion.matches
        ? "actle autocompletes to autocompletele"
        : "Replay: actle → autocompletele";
      if (reducedMotion.matches) stop();
    }

    button.addEventListener("click", play);
    word.addEventListener("animationend", (event) => {
      if (event.animationName === "actle-caret") stop();
    });
    reducedMotion.addEventListener("change", syncMotionPreference);
    syncMotionPreference();
    play();
  }
}());
