'use strict';

const { Device } = require('homey');
const VerisureClient = require('../../lib/VerisureClient');

/**
 * ContactSensorDevice
 *
 * Représente un capteur de contact Verisure (porte ou fenêtre) dans Homey.
 *
 * Capabilities déclarées dans app.json :
 *   - alarm_contact   (boolean) — true = ouvert, false = fermé
 *   - alarm_tamper    (boolean) — true = sabotage détecté
 *
 * Chaque device est identifié par son `deviceLabel` Verisure (ex: "1ABC2"),
 * stocké dans les settings du device lors du pairing.
 *
 * Le device ne poll pas lui-même — il s'abonne aux events du VerisurePoller
 * central géré par app.js. Cela garantit un unique appel API toutes les 10 min
 * quel que soit le nombre de capteurs couplés.
 */
class ContactSensorDevice extends Device {

  // ---------------------------------------------------------------------------
  // Cycle de vie Homey
  // ---------------------------------------------------------------------------

  async onInit() {
    const label = this.getSetting('deviceLabel');
    const area  = this.getSetting('area') || '';

    this.log(`[ContactSensor] Init — ${label} (${area})`);

    // Abonnement aux events du poller (via app.js)
    this._onContactChanged = this._onContactChanged.bind(this);
    this._onSessionExpired = this._onSessionExpired.bind(this);

    this.homey.app.poller.on('contact.changed', this._onContactChanged);
    this.homey.app.poller.on('session.expired',  this._onSessionExpired);

    // Synchronisation initiale depuis le dernier état connu du poller
    await this._syncFromCache();

    this.log(`[ContactSensor] Prêt — ${label}`);
  }

  async onDeleted() {
    const label = this.getSetting('deviceLabel');
    this.log(`[ContactSensor] Suppression — ${label}`);

    // Nettoyage des listeners pour éviter les fuites mémoire
    if (this.homey.app.poller) {
      this.homey.app.poller.off('contact.changed', this._onContactChanged);
      this.homey.app.poller.off('session.expired',  this._onSessionExpired);
    }
  }

  // ---------------------------------------------------------------------------
  // Synchronisation depuis le cache du poller
  // ---------------------------------------------------------------------------

  /**
   * Au démarrage, récupère l'état déjà connu du poller sans attendre
   * le prochain poll (évite un délai de 10 min après reboot Homey).
   */
  async _syncFromCache() {
    const label = this.getSetting('deviceLabel');
    const cachedState = this.homey.app.poller.getLastSensorState(label);

    if (cachedState === null) {
      // Le poller n'a pas encore tourné — on attend le premier event
      this.log(`[ContactSensor] ${label} — pas encore de cache, en attente du premier poll`);
      return;
    }

    const alarmContact = VerisureClient.toAlarmContact(cachedState);
    await this._setContactState(alarmContact, { silent: true });
    this.log(`[ContactSensor] ${label} — état initialisé depuis cache : ${cachedState}`);
  }

  // ---------------------------------------------------------------------------
  // Handlers d'événements poller
  // ---------------------------------------------------------------------------

  /**
   * Reçoit tous les changements de capteurs contact depuis le poller.
   * Filtre sur le deviceLabel de ce device.
   *
   * @param {{ deviceLabel: string, area: string, state: string, previous: string, alarmContact: boolean }} event
   */
  async _onContactChanged(event) {
    const label = this.getSetting('deviceLabel');

    // Ignorer les events des autres capteurs
    if (event.deviceLabel !== label) return;

    this.log(`[ContactSensor] ${label} — changement : ${event.previous} → ${event.state}`);

    await this._setContactState(event.alarmContact, { silent: false });
  }

  /**
   * La session Verisure a expiré — marquer le device comme indisponible.
   */
  async _onSessionExpired() {
    this.log(`[ContactSensor] ${this.getSetting('deviceLabel')} — session expirée, device indisponible`);
    await this.setUnavailable(this.homey.__('error.session_expired'));
  }

  // ---------------------------------------------------------------------------
  // Mise à jour des capabilities
  // ---------------------------------------------------------------------------

  /**
   * Met à jour la capability alarm_contact et déclenche les Flow triggers.
   *
   * @param {boolean} alarmContact - true = ouvert, false = fermé
   * @param {{ silent: boolean }} options - silent = pas de Flow trigger
   */
  async _setContactState(alarmContact, { silent = false } = {}) {
    try {
      const current = this.getCapabilityValue('alarm_contact');

      // Évite d'écrire si la valeur n'a pas changé (double protection)
      if (current === alarmContact) return;

      await this.setCapabilityValue('alarm_contact', alarmContact);

      // Remettre disponible si le device était marqué indisponible
      if (!this.getAvailable()) {
        await this.setAvailable();
      }

      // Déclencher les Flow triggers sauf lors de l'init silencieuse
      if (!silent) {
        await this._triggerFlows(alarmContact);
      }

    } catch (err) {
      this.error(`[ContactSensor] Erreur setCapabilityValue :`, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Flow triggers
  // ---------------------------------------------------------------------------

  /**
   * Déclenche les Flow cards correspondant au changement d'état.
   * Les cards sont déclarées dans app.json et enregistrées dans driver.js.
   *
   * @param {boolean} alarmContact
   */
  async _triggerFlows(alarmContact) {
    const label   = this.getSetting('deviceLabel');
    const area    = this.getSetting('area') || '';
    const tokens  = { area, device: this.getName() };

    try {
      if (alarmContact) {
        // Capteur ouvert
        await this.driver.triggerContactOpened(this, tokens);
        this.log(`[ContactSensor] ${label} — Flow "contact_opened" déclenché`);
      } else {
        // Capteur fermé
        await this.driver.triggerContactClosed(this, tokens);
        this.log(`[ContactSensor] ${label} — Flow "contact_closed" déclenché`);
      }
    } catch (err) {
      this.error(`[ContactSensor] Erreur Flow trigger :`, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings (appelé quand l'utilisateur modifie les réglages du device)
  // ---------------------------------------------------------------------------

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log(`[ContactSensor] Settings modifiés :`, changedKeys);
    // deviceLabel et area sont en lecture seule dans l'UI — pas d'action requise
  }

  // ---------------------------------------------------------------------------
  // Renommage du device
  // ---------------------------------------------------------------------------

  async onRenamed(name) {
    this.log(`[ContactSensor] Renommé en : ${name}`);
  }

}

module.exports = ContactSensorDevice;
