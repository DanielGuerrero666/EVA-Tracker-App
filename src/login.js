const form = document.getElementById('login-form');
const errorEl = document.getElementById('error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    errorEl.textContent = 'Email and password are required.';
    return;
  }

  try {
    await window.eva.login(email, password);
  } catch (err) {
    errorEl.textContent = err.message || 'Could not log in.';
  }
});
