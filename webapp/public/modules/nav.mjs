/*
 * Live bindings for the functions every feature needs and nobody can import
 * directly without a cycle: the shell imports each feature's render function, so
 * a feature importing the shell's render() back would close the loop. The shell
 * calls setNav() once at boot; `export let` makes the updated values visible to
 * every module that already imported them. `savePicker` is here for the same
 * reason — the Gear and Squad tabs each open with it, but it stays defined in
 * the shell (app.mjs) alongside the other save-level chrome.
 */
export let render = async () => {};
export let refresh = async () => {};
export let savePicker = () => '';

export function setNav(fns) {
  if (fns.render) render = fns.render;
  if (fns.refresh) refresh = fns.refresh;
  if (fns.savePicker) savePicker = fns.savePicker;
}
