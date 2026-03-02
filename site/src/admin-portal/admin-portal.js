import { BaseElement } from "../base-element/base-element";
import { api } from "../data/api";
import { storage } from "../data/storage";

export class AdminPortal extends BaseElement {
  constructor() {
    super();
  }

  html() {
    return `{{admin-portal.html}}`;
  }

  connectedCallback() {
    super.connectedCallback();

    const session = storage.getSession();
    if (session.role !== "admin") {
      window.history.pushState("", "", "/group");
      return;
    }

    api.setSession(session.sessionToken, session.username, session.role);
    this.render();
    this.loadUsers();
    this.loadAuditLog();
    this.setupCreateUser();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
  }

  setupCreateUser() {
    const createBtn = this.querySelector(".admin-portal__create-btn");
    if (createBtn) {
      this.eventListener(createBtn, "click", this.handleCreateUser.bind(this));
    }
  }

  async handleCreateUser() {
    const usernameInput = this.querySelector(".admin-portal__new-username");
    const passwordInput = this.querySelector(".admin-portal__new-password");
    const roleSelect = this.querySelector(".admin-portal__role-dropdown");
    const errorEl = this.querySelector(".admin-portal__create-error");

    if (!usernameInput.valid || !passwordInput.valid) {
      errorEl.innerHTML = "Please fill in all required fields.";
      return;
    }

    errorEl.innerHTML = "";
    try {
      const response = await api.adminCreateUser(usernameInput.value, passwordInput.value, roleSelect.value);
      if (response.ok) {
        usernameInput.value = "";
        passwordInput.value = "";
        this.loadUsers();
        this.loadAuditLog();
      } else {
        const body = await response.text();
        errorEl.innerHTML = `Error: ${body}`;
      }
    } catch (e) {
      errorEl.innerHTML = `Error: ${e}`;
    }
  }

  async loadUsers() {
    try {
      const response = await api.adminListUsers();
      if (!response.ok) return;
      const users = await response.json();
      this.renderUsers(users);
    } catch (e) {
      // ignore
    }
  }

  renderUsers(users) {
    const container = this.querySelector(".admin-portal__user-list");
    if (!container) return;

    const session = storage.getSession();

    container.innerHTML = users
      .map((user) => {
        const roleBadge = user.role === "admin"
          ? `<span class="admin-portal__badge admin-portal__badge--admin">admin</span>`
          : `<span class="admin-portal__badge admin-portal__badge--member">member</span>`;
        const disabledBadge = !user.enabled
          ? `<span class="admin-portal__badge admin-portal__badge--disabled">disabled</span>`
          : "";
        const lastSeen = user.last_seen ? new Date(user.last_seen).toLocaleString() : "Never";
        const isSelf = user.username === session.username;

        let actions = "";
        if (!isSelf) {
          if (user.enabled) {
            actions += `<button class="men-button" data-action="disable" data-user-id="${user.user_id}">Disable</button>`;
          } else {
            actions += `<button class="men-button" data-action="enable" data-user-id="${user.user_id}">Enable</button>`;
          }
          const newRole = user.role === "admin" ? "member" : "admin";
          actions += `<button class="men-button" data-action="role" data-user-id="${user.user_id}" data-role="${newRole}">Make ${newRole}</button>`;
          actions += `<button class="men-button" data-action="kick" data-user-id="${user.user_id}">Kick</button>`;
        }

        return `
          <div class="admin-portal__user-row">
            <div class="admin-portal__user-info">
              <strong>${user.username}</strong>
              ${roleBadge}
              ${disabledBadge}
              <span style="font-size:0.8rem;color:#999">Last seen: ${lastSeen}</span>
            </div>
            <div class="admin-portal__user-actions">${actions}</div>
          </div>
        `;
      })
      .join("");

    // Bind action buttons
    container.querySelectorAll("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => this.handleUserAction(btn));
    });
  }

  async handleUserAction(btn) {
    const action = btn.dataset.action;
    const userId = parseInt(btn.dataset.userId);

    try {
      let response;
      switch (action) {
        case "disable":
          response = await api.adminDisableUser(userId);
          break;
        case "enable":
          response = await api.adminEnableUser(userId);
          break;
        case "role":
          response = await api.adminChangeUserRole(userId, btn.dataset.role);
          break;
        case "kick":
          if (!confirm("Are you sure you want to kick this user? This will delete their account and revoke all tokens.")) {
            return;
          }
          response = await api.adminKickUser(userId);
          break;
      }

      if (response && response.ok) {
        this.loadUsers();
        this.loadAuditLog();
      }
    } catch (e) {
      // ignore
    }
  }

  async loadAuditLog() {
    try {
      const response = await api.adminGetAuditLog();
      if (!response.ok) return;
      const entries = await response.json();
      this.renderAuditLog(entries);
    } catch (e) {
      // ignore
    }
  }

  renderAuditLog(entries) {
    const container = this.querySelector(".admin-portal__audit-log");
    if (!container) return;

    if (entries.length === 0) {
      container.innerHTML = "<p>No audit entries yet.</p>";
      return;
    }

    container.innerHTML = entries
      .map((entry) => {
        const time = new Date(entry.created_at).toLocaleString();
        const details = entry.details || entry.action;
        return `
          <div class="admin-portal__audit-entry">
            <span class="admin-portal__audit-time">${time}</span>
            <span>${details}</span>
          </div>
        `;
      })
      .join("");
  }
}

customElements.define("admin-portal", AdminPortal);
