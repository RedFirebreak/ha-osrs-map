import { BaseElement } from "../base-element/base-element";
import { api } from "../data/api";

/**
 * Signing in goes through Discord: the button asks the server where to go and
 * sends the browser there. Discord sends it back to /login/discord (see
 * discord-callback), where the hub's verdict comes in.
 *
 * The page also says what the site is and who it is for: to someone who isn't
 * signed in, this is all there is to tell it from a page that is after a login.
 * What it says the map reads from Discord is what the server reads
 * (discord_routes.rs: scope `identify`, the id and the names).
 */
export class LoginPage extends BaseElement {
  constructor() {
    super();
  }

  html() {
    return `{{login-page.html}}`;
  }

  connectedCallback() {
    super.connectedCallback();
    this.render();
    // As text: the name is whatever SITE_NAME was set to.
    this.querySelector(".login__title").textContent = window.siteConfig?.title || "OSRS Guild Map";
    this.button = this.querySelector(".login__discord-button");
    this.error = this.querySelector(".login__error");
    this.eventListener(this.button, "click", this.login.bind(this));
  }

  async login() {
    this.error.textContent = "";
    this.button.disabled = true;
    try {
      const { auth_url } = await api.discordStart();
      window.location.assign(auth_url);
    } catch (error) {
      this.error.textContent = `Unable to log in: ${error.message}`;
      this.button.disabled = false;
    }
  }
}

customElements.define("login-page", LoginPage);
