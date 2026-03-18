const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String }, // Pas obligatoire car on peut se connecter avec Google
    googleId: { type: String }, // Pour la connexion Google
    balance: { type: Number, default: 999999999 }, // Argent presque infini par défaut
    notifyByEmail: { type: Boolean, default: false } // Case pour les notifications par mail
});

module.exports = mongoose.model('User', userSchema);