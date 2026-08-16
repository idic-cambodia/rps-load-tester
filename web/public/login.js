document.querySelector("#login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CSRF-Token": document.querySelector("#csrf").value,
    },
    body: JSON.stringify({
      username: document.querySelector("#username").value,
      password: document.querySelector("#password").value,
    }),
  });
  if (r.ok) location.href = "/";
  else document.querySelector("#error").textContent = (await r.json()).error;
});
