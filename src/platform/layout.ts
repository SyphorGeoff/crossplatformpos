/*
 * Layout mode. "mini" is the posx mini layout (posx on a Stripe S710: a 5.5"
 * 1920x1080 portrait panel the WebView reports at roughly 360x640 CSS px):
 * single column, the check panel slides over the menu behind a button.
 *
 * The xmini build (npm run build:mini, __APP_MINI__ true, its own version
 * line in package.json "miniVersion") forces mini; the xpos build picks it by
 * viewport width. On a screen wider than a phone, a forced mini boxes the app
 * into a 360x640 frame (the frame is the containing block for every
 * fixed-position sheet, so the whole UI stays inside it); on a phone or the
 * reader it just fills the screen. `?mini` forces it on the dev server.
 */

const MINI_QUERY = "(max-width: 760px)";   // xpos: narrow viewport → mini layout
const FRAME_QUERY = "(min-width: 440px)";  // forced mini: room for the 380px frame → draw it

export function installLayout(): void {
  const html = document.documentElement;
  const forced = __APP_MINI__ || new URLSearchParams(window.location.search).has("mini");
  const mini = window.matchMedia(MINI_QUERY);
  const room = window.matchMedia(FRAME_QUERY);
  const apply = () => {
    html.dataset.layout = forced || mini.matches ? "mini" : "full";
    html.classList.toggle("miniframe", forced && room.matches);
  };
  apply();
  for (const mq of [mini, room]) {
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", apply);
    else mq.addListener(apply); // older WebViews
  }
}
