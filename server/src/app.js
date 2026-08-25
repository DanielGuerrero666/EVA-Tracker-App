const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const { apiLimiter } = require('./middleware/rateLimit');
const { errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth.routes');
const timeRoutes = require('./routes/time.routes');
const breakRoutes = require('./routes/break.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();

app.use(helmet());
app.use(express.json({ limit: '100kb' }));
app.use(morgan('combined'));
app.use('/api', apiLimiter);

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/time', timeRoutes);
app.use('/api/break', breakRoutes);
app.use('/api/admin', adminRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
