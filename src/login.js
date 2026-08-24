const form = document.getElementById('login-form');
const errorEl = document.getElementById('error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';

  const name = document.getElementById('name').value.trim();
  const email = document.getElementById('email').value.trim();

  if (!name || !email) {
    errorEl.textContent = 'Name and email are required.';
    return;
  }

  try {
    await window.eva.login(name, email);
  } catch (err) {
    errorEl.textContent = err.message || 'Could not log in.';
  }
});
