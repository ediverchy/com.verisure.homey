'use strict';

const { EventEmitter } = require('events');
const VerisureClient = require('./VerisureClient');

// Intervalle de polling par défaut : 10 minutes (en ms)
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

// Backoff exponentiel : délais successifs après erreur (en ms)
const BACKOFF_STEPS = [
  1  * 60 * 1000,  // 1 min
  5  * 60 * 1000,  // 5 min
  15 * 60 * 1000,  // 15 min
];

/**
 * VerisurePoller
 *
 * Orchestre le polling cloud Verisure et émet des événements Homey
 * uniquement quand l'état change (diff local).
 *
 * Événements émis :
 *   'contact.changed'  ({ deviceLabel, area, state, previous })
 *   'alarm.changed'    ({ statusType, previous })
 *   'poll.success'     ({ doorWindows, armState, ts })
 *   'poll.error'       (Error)
 *   'session.expired'  ()
 *
 * Usage dans app.js :
 *   this.poller = new VerisurePoller({ homey: this.homey });
 *   this.poller.on('contact.changed', ({ deviceLabel, state }) => { ... });
 *   await this.poller.start();
 */
class VerisurePoller extends EventEmitter {

  /**
   * @param {object} options
   * @param {import('@homeyapp/homey')} options.homey       - instance Homey
   * @param {number}  [options.intervalMs]                  - intervalle polling (défaut 10 min)
   */
  constructor({ homey, intervalMs }) {
    super();

    this.homey = homey;
    this.intervalMs = intervalMs || DEFAULT_INTERVAL_MS;

    this._client = null;       // VerisureClient
    this._timer = null;        // référence setInterval
    this._backoffIndex = 0;    // index dans BACKOFF_STEPS
    this._backoffTimer = null; // référence setTimeout (backoff)
    this._running = false;

    // Cache du dernier état connu — clé = deviceLabel, valeur = état string
    this._lastDoorWindows = new Map(); // deviceLabel → 'OPEN'|'CLOSED'
    this._lastArmState = null;         // 'ARMED_AWAY'|'ARMED_HOME'|'DISARMED'
    this._lastMotionSensors = new Map(); // deviceLabel → boolean (mouvement actif)
  }

  // ---------------------------------------------------------------------------
  // Cycle de vie
  // ---------------------------------------------------------------------------

  /**
   * Démarre le polling.
   * Effectue un premier poll immédiat puis programme l'intervalle régulier.
   */
  async start() {
    if (this._running) {
      this.homey.log('[VerisurePoller] Déjà en cours — start() ignoré');
      return;
    }

    this.homey.log(`[VerisurePoller] Démarrage (intervalle : ${this.intervalMs / 1000}s)`);

    try {
      this._client = VerisureClient.fromSettings({ homey: this.homey });
    } catch (err) {
      this.homey.log('[VerisurePoller] Pas de session enregistrée — polling suspendu');
      return;
    }

    this._running = true;
    this._backoffIndex = 0;

    // Premier poll immédiat
    await this._poll();

    // Intervalle régulier
    this._timer = setInterval(() => this._poll(), this.intervalMs);
  }

  /**
   * Arrête le polling proprement.
   */
  stop() {
    this.homey.log('[VerisurePoller] Arrêt');
    this._running = false;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    if (this._backoffTimer) {
      clearTimeout(this._backoffTimer);
      this._backoffTimer = null;
    }
  }

  /**
   * Force un poll immédiat (ex: Flow action "Rafraîchir maintenant").
   */
  async pollNow() {
    this.homey.log('[VerisurePoller] Poll manuel déclenché');
    await this._poll();
  }

  /**
   * Met à jour l'intervalle de polling à chaud (depuis les settings app).
   * @param {number} intervalMs
   */
  setInterval(intervalMs) {
    this.intervalMs = intervalMs;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = setInterval(() => this._poll(), this.intervalMs);
      this.homey.log(`[VerisurePoller] Intervalle mis à jour : ${intervalMs / 1000}s`);
    }
  }

  /**
   * Réinitialise le client et redémarre le polling.
   * Appelé après un re-pairing (nouveaux cookies).
   */
  async restart() {
    this.stop();
    await this.start();
  }

  // ---------------------------------------------------------------------------
  // Poll principal
  // ---------------------------------------------------------------------------

  /**
   * Effectue un snapshot Verisure, diff avec le cache, émet les changements.
   * Gère les erreurs avec backoff exponentiel.
   */
  async _poll() {
    this.homey.log('[VerisurePoller] Poll en cours...');

    try {
      const snapshot = await this._client.getFullSnapshot();
      const ts = Date.now();

      this._processDoorWindows(snapshot.doorWindows);
      this._processArmState(snapshot.armState);

      // Traitement des capteurs PIR (si présents dans le snapshot)
      if (snapshot.motionSensors && snapshot.motionSensors.length > 0) {
        this._processMotionSensors(snapshot.motionSensors);
      }

      // Réinitialise le backoff après un succès
      this._backoffIndex = 0;
      if (this._backoffTimer) {
        clearTimeout(this._backoffTimer);
        this._backoffTimer = null;
      }

      this.emit('poll.success', {
        doorWindows: snapshot.doorWindows,
        armState: snapshot.armState,
        ts,
      });

      this.homey.log(`[VerisurePoller] Poll OK — ${snapshot.doorWindows.length} capteur(s)`);

    } catch (err) {
      this.homey.error('[VerisurePoller] Erreur poll :', err.message);
      this.emit('poll.error', err);

      // Session définitivement expirée → notification + arrêt
      if (err.message && err.message.includes('reconnexion requise')) {
        this.emit('session.expired');
        this.stop();
        return;
      }

      // Autres erreurs → backoff exponentiel
      this._scheduleBackoff();
    }
  }

  // ---------------------------------------------------------------------------
  // Diff & émission d'événements
  // ---------------------------------------------------------------------------

  /**
   * Compare les capteurs contact avec le cache.
   * Émet 'contact.changed' uniquement pour les capteurs dont l'état a changé.
   *
   * @param {Array} doorWindows - tableau de capteurs depuis getFullSnapshot()
   */
  _processDoorWindows(doorWindows) {
    for (const sensor of doorWindows) {
      const { deviceLabel, area, state } = sensor;
      const previous = this._lastDoorWindows.get(deviceLabel);

      if (previous === undefined) {
        // Premier poll : on hydrate le cache sans émettre d'événement
        this._lastDoorWindows.set(deviceLabel, state);
        this.homey.log(`[VerisurePoller] Cache initialisé — ${deviceLabel} : ${state}`);
        continue;
      }

      if (state !== previous) {
        this.homey.log(`[VerisurePoller] Changement contact — ${deviceLabel} : ${previous} → ${state}`);
        this._lastDoorWindows.set(deviceLabel, state);

        this.emit('contact.changed', {
          deviceLabel,
          area,
          state,          // 'OPEN' | 'CLOSED'
          previous,
          alarmContact: VerisureClient.toAlarmContact(state),
        });
      }
    }
  }

  /**
   * Compare l'état alarme avec le cache.
   * Émet 'alarm.changed' si l'état a changé.
   *
   * @param {object|null} armState
   */
  _processArmState(armState) {
    if (!armState) return;

    const { statusType, date, changedVia } = armState;

    if (this._lastArmState === null) {
      // Premier poll : hydratation silencieuse
      this._lastArmState = statusType;
      this.homey.log(`[VerisurePoller] Cache alarme initialisé : ${statusType}`);
      return;
    }

    if (statusType !== this._lastArmState) {
      this.homey.log(`[VerisurePoller] Changement alarme : ${this._lastArmState} → ${statusType}`);
      const previous = this._lastArmState;
      this._lastArmState = statusType;

      this.emit('alarm.changed', {
        statusType,                // 'ARMED_AWAY' | 'ARMED_HOME' | 'DISARMED'
        homeyState: VerisureClient.toHomeyAlarmState(statusType),
        previous,
        date,
        changedVia,
      });
    }
  }

  /**
   * Compare les capteurs PIR avec le cache.
   * Émet 'motion.changed' uniquement si l'état a changé.
   *
   * Note : Verisure ne retourne pas l'état PIR en temps réel.
   * L'état "mouvement actif" est inféré depuis latestDetection :
   * si la dernière détection date de moins de 5 min → motionDetected = true.
   *
   * @param {Array<{ deviceLabel: string, area: string, latestDetection: string }>} motionSensors
   */
  _processMotionSensors(motionSensors) {
    const now = Date.now();

    for (const sensor of motionSensors) {
      const { deviceLabel, area, latestDetection } = sensor;

      const detectedAt = latestDetection ? new Date(latestDetection).getTime() : 0;
      const isActive   = (now - detectedAt) < 5 * 60 * 1000; // actif si < 5 min
      const previous   = this._lastMotionSensors.get(deviceLabel);

      if (previous === undefined) {
        // Premier poll : hydratation silencieuse sans émettre d'event
        this._lastMotionSensors.set(deviceLabel, isActive);
        this.homey.log(`[VerisurePoller] Cache PIR initialisé — ${deviceLabel} : ${isActive}`);
        continue;
      }

      if (isActive !== previous) {
        this.homey.log(`[VerisurePoller] Changement PIR — ${deviceLabel} : ${previous} → ${isActive}`);
        this._lastMotionSensors.set(deviceLabel, isActive);

        this.emit('motion.changed', {
          deviceLabel,
          area,
          motionDetected: isActive,
          previous,
          latestDetection,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Backoff exponentiel
  // ---------------------------------------------------------------------------

  /**
   * Suspend le polling normal et programme un retry après délai croissant.
   * Au-delà du dernier palier, notifie l'utilisateur et arrête le polling.
   */
  _scheduleBackoff() {
    // Pause le timer régulier pendant le backoff
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    if (this._backoffIndex >= BACKOFF_STEPS.length) {
      // Tous les paliers épuisés → notification + arrêt
      this.homey.log('[VerisurePoller] Backoff épuisé — arrêt et notification');

      this.homey.notifications.createNotification({
        excerpt: 'Verisure : impossible de joindre le service après plusieurs tentatives. Vérifiez votre connexion ou reconnectez l\'app.',
      }).catch(() => {});

      this.stop();
      return;
    }

    const delay = BACKOFF_STEPS[this._backoffIndex];
    this._backoffIndex++;

    this.homey.log(`[VerisurePoller] Backoff #${this._backoffIndex} — retry dans ${delay / 1000}s`);

    this._backoffTimer = setTimeout(async () => {
      this._backoffTimer = null;

      // Retry du poll
      await this._poll();

      // Si succès (backoffIndex remis à 0), relancer l'intervalle régulier
      if (this._backoffIndex === 0 && this._running) {
        this._timer = setInterval(() => this._poll(), this.intervalMs);
      }
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Introspection (utile pour les settings / debug)
  // ---------------------------------------------------------------------------

  /**
   * Retourne un snapshot de l'état interne du poller.
   * @returns {{ running: boolean, backoffIndex: number, lastArmState: string, sensorCount: number }}
   */
  getStatus() {
    return {
      running: this._running,
      backoffIndex: this._backoffIndex,
      lastArmState: this._lastArmState,
      sensorCount: this._lastDoorWindows.size,
      intervalMs: this.intervalMs,
    };
  }

  /**
   * Retourne le dernier état connu d'un capteur spécifique.
   * @param {string} deviceLabel
   * @returns {'OPEN'|'CLOSED'|null}
   */
  getLastSensorState(deviceLabel) {
    return this._lastDoorWindows.get(deviceLabel) ?? null;
  }

}

module.exports = VerisurePoller;
