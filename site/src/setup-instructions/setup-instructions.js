import { BaseElement } from "../base-element/base-element";
import { api } from "../data/api";

export class SetupInstructions extends BaseElement {
  constructor() {
    super();
  }

  html() {
    return `{{setup-instructions.html}}`;
  }

  connectedCallback() {
    super.connectedCallback();
    this.render();
    this.eventListener(this.querySelector(".setup__pair-btn"), "click", this.handleGenerateCode.bind(this));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
  }

  async handleGenerateCode() {
    const btn = this.querySelector(".setup__pair-btn");
    const result = this.querySelector(".setup__pair-result");
    const error = this.querySelector(".setup__pair-error");

    btn.disabled = true;
    btn.textContent = "Generating...";
    error.textContent = "";
    result.textContent = "";

    try {
      const response = await api.generatePairingCode();

      if (!response.ok) {
        const message = await response.text();
        error.textContent = `Error: ${message}`;
      } else {
        const data = await response.json();
        result.textContent = data.code;
      }
    } catch (e) {
      error.textContent = "Failed to generate pairing code.";
    }

    btn.disabled = false;
    btn.textContent = "Generate Pairing Code";
  }
}

customElements.define("setup-instructions", SetupInstructions);
