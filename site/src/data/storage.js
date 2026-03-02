class Storage {
  storeSession(sessionToken, username, role) {
    localStorage.setItem("sessionToken", sessionToken);
    localStorage.setItem("username", username);
    localStorage.setItem("role", role);
  }

  getSession() {
    return {
      sessionToken: localStorage.getItem("sessionToken"),
      username: localStorage.getItem("username"),
      role: localStorage.getItem("role"),
    };
  }

  clearSession() {
    localStorage.removeItem("sessionToken");
    localStorage.removeItem("username");
    localStorage.removeItem("role");
  }

  // Legacy compat
  storeGroup(groupName, groupToken) {
    localStorage.setItem("groupName", groupName);
    localStorage.setItem("groupToken", groupToken);
  }

  getGroup() {
    return {
      groupName: localStorage.getItem("groupName"),
      groupToken: localStorage.getItem("groupToken"),
    };
  }

  clearGroup() {
    localStorage.removeItem("groupName");
    localStorage.removeItem("groupToken");
  }
}

const storage = new Storage();

export { storage };
