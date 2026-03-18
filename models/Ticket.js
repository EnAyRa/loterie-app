const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // L'ID du joueur
    lotteryType: { type: String, enum: ['5min', '1h', '1j', '1m'], required: true }, // Le type de loterie
    dateParticipation: { type: Date, default: Date.now } // La date d'achat
});

module.exports = mongoose.model('Ticket', ticketSchema);