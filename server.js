require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcrypt');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cron = require('node-cron');
const http = require('http');
const socketIo = require('socket.io');
const nodemailer = require('nodemailer'); // NOUVEAU: L'outil pour les emails

const User = require('./models/User');
const Ticket = require('./models/Ticket');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- CONFIGURATION EMAILS (Nodemailer) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Fonction pour envoyer un email
async function envoyerEmail(destinataire, sujet, texte) {
    try {
        await transporter.sendMail({
            from: `"Loterie Infinite" <${process.env.EMAIL_USER}>`,
            to: destinataire,
            subject: sujet,
            text: texte
        });
        console.log(`📧 Email envoyé à ${destinataire}`);
    } catch (error) {
        console.error(`❌ Erreur d'envoi d'email à ${destinataire}:`, error);
    }
}

// --- CONFIGURATION SERVEUR ---
app.set('view engine', 'ejs'); 
app.use(express.urlencoded({ extended: true })); 
app.use(express.static('public')); 

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// --- CONFIGURATION DU VIDEUR (Passport) ---
passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
        const user = await User.findOne({ email: email });
        if (!user) return done(null, false, { message: 'Utilisateur non trouvé' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return done(null, false, { message: 'Mot de passe incorrect' });
        return done(null, user);
    } catch (error) { return done(error); }
}));

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "http://localhost:3000/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
      try {
          let user = await User.findOne({ googleId: profile.id });
          if (user) return done(null, user);
          
          let existingEmailUser = await User.findOne({ email: profile.emails[0].value });
          if (existingEmailUser) {
              existingEmailUser.googleId = profile.id;
              await existingEmailUser.save();
              return done(null, existingEmailUser);
          }

          const newUser = new User({
              username: profile.displayName,
              email: profile.emails[0].value,
              googleId: profile.id,
              notifyByEmail: true // On peut activer par défaut pour Google
          });
          await newUser.save();
          return done(null, newUser);
      } catch (error) { return done(error, false); }
  }
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (error) { done(error); }
});

// --- CONNEXION BASE DE DONNÉES ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connecté à MongoDB !'))
    .catch(err => console.error('❌ Erreur:', err));

// --- ROUTES ---
app.get('/', (req, res) => { res.render('login'); });

app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const notifyByEmail = req.body.notifyByEmail === 'on';
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, email, password: hashedPassword, notifyByEmail });
        await newUser.save();
        res.send('<h1>Inscription réussie ! 🎉</h1><a href="/">Retour à la connexion</a>');
    } catch (error) {
        res.send('<h1>Erreur. Email déjà utilisé ?</h1><a href="/">Réessayer</a>');
    }
});

app.post('/login', passport.authenticate('local', { successRedirect: '/dashboard', failureRedirect: '/' }));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => { res.redirect('/dashboard'); });

app.get('/dashboard', (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    res.render('dashboard', { user: req.user });
});

app.post('/participer', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const prixTicket = 500;
    const { lotteryType } = req.body;
    const user = req.user;

    try {
        if (user.balance < prixTicket) return res.render('dashboard', { user: user, message: "❌ Tu n'as plus assez d'argent !" });
        
        user.balance -= prixTicket;
        await user.save();
        
        const nouveauTicket = new Ticket({ userId: user._id, lotteryType: lotteryType });
        await nouveauTicket.save();
        
        res.render('dashboard', { user: user, message: `✅ Ticket ${lotteryType} acheté !` });
    } catch (error) {
        res.render('dashboard', { user: user, message: "❌ Une erreur s'est produite." });
    }
});

app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

// --- LE MOTEUR DE TIRAGE AU SORT EN TEMPS RÉEL + EMAILS ---
async function effectuerTirage(typeLoterie, gain) {
    try {
        const tickets = await Ticket.find({ lotteryType: typeLoterie }).populate('userId');

        if (tickets.length === 0) {
            io.emit('resultat_loterie', { typeLoterie: typeLoterie, message: "Tirage terminé : Aucun participant ! 😢" });
            return;
        }

        const indexGagnant = Math.floor(Math.random() * tickets.length);
        const joueurGagnant = tickets[indexGagnant].userId;

        joueurGagnant.balance += gain;
        await joueurGagnant.save();

        io.emit('resultat_loterie', { 
            typeLoterie: typeLoterie, 
            message: `🎉 LE GAGNANT EST ${joueurGagnant.username.toUpperCase()} ! Gain : ${gain.toLocaleString()} $ !`
        });

        // NOUVEAU : On gère les emails !
        // 1. On regroupe les joueurs pour ne pas envoyer 10 mails à celui qui a acheté 10 tickets
        const joueursUniques = new Map();
        tickets.forEach(ticket => {
            joueursUniques.set(ticket.userId._id.toString(), ticket.userId);
        });

        // 2. On envoie les mails à ceux qui ont coché la case
        joueursUniques.forEach((joueur) => {
            if (joueur.notifyByEmail) {
                if (joueur._id.toString() === joueurGagnant._id.toString()) {
                    envoyerEmail(joueur.email, "🎉 TU AS GAGNÉ LE GROS LOT !", `Incroyable ${joueur.username} ! Tu viens de remporter ${gain.toLocaleString()} $ à la loterie ${typeLoterie} !! Connecte-toi vite pour voir ton nouveau solde !`);
                } else {
                    envoyerEmail(joueur.email, "😢 Résultat du tirage Loterie", `Dommage ${joueur.username}... Le gagnant de la loterie ${typeLoterie} cette fois-ci est ${joueurGagnant.username}. Ne perds pas espoir, tu as des fonds infinis !`);
                }
            }
        });

        await Ticket.deleteMany({ lotteryType: typeLoterie });

    } catch (error) {
        console.error(`❌ Erreur tirage ${typeLoterie}:`, error);
    }
}

// Les crons (j'ai laissé 1 minute pour que tu puisses tester !)
cron.schedule('*/5 * * * *', () => { effectuerTirage('5min', 10000); });
cron.schedule('0 * * * *', () => { effectuerTirage('1h', 500000); });
cron.schedule('0 0 * * *', () => { effectuerTirage('1j', 10000000); });
cron.schedule('0 0 1 * *', () => { effectuerTirage('1m', 500000000); });

// --- LANCEMENT DU SERVEUR ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Serveur temps réel démarré sur http://localhost:${PORT}`);
});