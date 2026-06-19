const DEFAULTS = { slot1: "1", slot2: "2", slot3: "3" };
const inputs = { slot1: document.getElementById("k1"), slot2: document.getElementById("k2"), slot3: document.getElementById("k3") };

browser.storage.local.get(DEFAULTS).then((cfg) => {
  inputs.slot1.value = cfg.slot1.toUpperCase();
  inputs.slot2.value = cfg.slot2.toUpperCase();
  inputs.slot3.value = cfg.slot3.toUpperCase();
});

Object.entries(inputs).forEach(([slot, input]) => {
  input.addEventListener("input", () => {
    const val = input.value.toLowerCase().trim();
    if (!val) return;
    browser.storage.local.set({ [slot]: val }).then(() => {
      document.getElementById("saved").style.display = "block";
      setTimeout(() => document.getElementById("saved").style.display = "none", 1500);
    });
  });
});
