import { BaseElement } from "../base-element/base-element";
import { storage } from "../data/storage";
import { api } from "../data/api";
import { exampleData } from "../data/example-data";

export class LogoutPage extends BaseElement {
  constructor() {
    super();
  }

  html() {
    return `{{logout-page.html}}`;
  }

  async connectedCallback() {
    super.connectedCallback();
    exampleData.disable();

    // Attempt server-side logout
    try {
      await api.logout();
    } catch (e) {
      // Continue even if server logout fails
    }

    api.disable();
    storage.clearSession();
    storage.clearGroup();
    window.history.pushState("", "", "/");
  }

  disconnectedCallback() {
    super.disconnectedCallback();
  }
}

customElements.define("logout-page", LogoutPage);
