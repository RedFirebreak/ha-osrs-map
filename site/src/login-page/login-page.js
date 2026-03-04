import { BaseElement } from "../base-element/base-element";
import { storage } from "../data/storage";
import { api } from "../data/api";

export class LoginPage extends BaseElement {
  constructor() {
    super();
  }

  html() {
    return `{{login-page.html}}`;
  }

  connectedCallback() {
    super.connectedCallback();
    this.checkSetupStatus();
  }

  async checkSetupStatus() {
    try {
      const status = await api.getSetupStatus();
      if (status.needs_setup) {
        window.history.pushState("", "", "/setup");
        return;
      }
    } catch (e) {
      // Continue to login if setup check fails
    }

    this.render();

    const fieldRequiredValidator = (value) => {
      if (value.length === 0) {
        return "This field is required.";
      }
    };
    this.name = this.querySelector(".login__name");
    this.name.validators = [fieldRequiredValidator];
    this.token = this.querySelector(".login__token");
    this.token.validators = [fieldRequiredValidator];
    this.loginButton = this.querySelector(".login__button");
    this.error = this.querySelector(".login__error");
    this.eventListener(this.loginButton, "click", this.login.bind(this));

    this.checkDiscordEnabled();
  }

  async checkDiscordEnabled() {
    try {
      const data = await api.getDiscordEnabled();
      if (data.enabled && data.auth_url) {
        const divider = this.querySelector(".login__discord-divider");
        const discordBtn = this.querySelector(".login__discord-button");
        if (divider) divider.style.display = "";
        if (discordBtn) {
          discordBtn.style.display = "";
          discordBtn.href = data.auth_url;
        }
      }
    } catch (e) {
      console.warn("Discord auth check failed:", e);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
  }

  async login() {
    if (!this.name.valid || !this.token.valid) return;
    try {
      this.error.innerHTML = "";
      this.loginButton.disabled = true;
      const username = this.name.value;
      const password = this.token.value;

      const response = await api.login(username, password);
      if (response.ok) {
        const data = await response.json();
        storage.storeSession(data.session_token, data.username, data.role);
        api.setSession(data.session_token, data.username, data.role);
        window.history.pushState("", "", "/group");
      } else {
        const body = await response.text();
        if (response.status === 401) {
          this.error.innerHTML = "Invalid username or password";
        } else {
          this.error.innerHTML = `Unable to login: ${body}`;
        }
      }
    } catch (error) {
      this.error.innerHTML = `Unable to login: ${error}`;
    } finally {
      this.loginButton.disabled = false;
    }
  }
}

customElements.define("login-page", LoginPage);
