/*jshint browser:true, jQuery: true, forin: true, laxbreak:true */
/*global BrowserID: true */
/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Mozilla BrowserID.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */
(function() {
  var bid = BrowserID,
      storage = bid.Storage,
      mediator = bid.Mediator,
      user = bid.User,
      publish = mediator.publish.bind(mediator),
      subscriptions = [],
      stateStack = [],
      controller,
      moduleManager = bid.module,
      errors = bid.Errors,
      addPrimaryUser = false,
      email,
      requiredEmail;

  function subscribe(message, cb) {
    subscriptions.push(mediator.subscribe(message, cb));
  }

  function unsubscribeAll() {
    while(subscription = subscriptions.pop()) {
      mediator.unsubscribe(subscription);
    }
  }

  function gotoState(push, funcName) {
    var args = [].slice.call(arguments, 1);

    if (typeof push === "boolean") {
      // Must take the push param off to get to funcName and then the remaining
      // arguments.
      args = [].slice.call(args, 1);
    }
    else {
      funcName = push;
      push = true;
    }

    if (push) {
      pushState(funcName, args);
    }

    controller[funcName].apply(controller, args);
  }

  function pushState(funcName, args) {
    // Remember the state and the information for the state in case we have to
    // go back to it.
    stateStack.push({
      funcName: funcName,
      args: args
    });
  }

  // Used for when the current state is being cancelled and the user wishes to
  // go to the previous state.
  function popState() {
    // Skip the first state, it is where the user is at now.
    stateStack.pop();

    var state = stateStack[stateStack.length - 1];
    if (state) {
      controller[state.funcName].apply(controller, state.args);
    }
  }

  function startStateMachine() {
    var self = this,
        startState = gotoState.bind(self),
        cancelState = popState.bind(self);

    subscribe("offline", function(msg, info) {
      startState("doOffline");
    });

    subscribe("start", function(msg, info) {
      info = info || {};

      self.hostname = info.hostname;
      self.allowPersistent = !!info.allowPersistent;
      requiredEmail = info.requiredEmail;

      if ((typeof(requiredEmail) !== "undefined")
       && (!bid.verifyEmail(requiredEmail))) {
        // Invalid format
        startState("doError", "invalid_required_email", {email: requiredEmail});
      }
      else {
        startState("doCheckAuth");
      }
    });

    subscribe("cancel", function() {
      startState("doCancel");
    });

    subscribe("window_unload", function() {
      if (!self.success) {
        bid.Storage.setStagedOnBehalfOf("");
        startState("doCancel");
      }
    });

    subscribe("authentication_checked", function(msg, info) {
      var authenticated = info.authenticated;

      if (requiredEmail) {
        startState("doAuthenticateWithRequiredEmail", {
          email: requiredEmail,
          authenticated: authenticated
        });
      }
      else if (authenticated) {
        publish("pick_email");
      } else {
        publish("authenticate");
      }
    });

    subscribe("authenticate", function(msg, info) {
      info = info || {};

      startState("doAuthenticate", {
        email: info.email
      });
    });

    subscribe("user_staged", function(msg, info) {
      startState("doConfirmUser", info.email);
    });

    subscribe("user_confirmed", function() {
      startState("doEmailConfirmed");
    });

    subscribe("primary_user", function(msg, info) {
      addPrimaryUser = !!info.add;
      email = info.email;
      // We don't want to put the provisioning step on the stack, instead when
      // a user cancels this step, they should go back to the step before the
      // provisioning.
      startState(false, "doProvisionPrimaryUser", info);
    });

    subscribe("primary_user_provisioned", function(msg, info) {
      info = info || {};
      info.add = !!addPrimaryUser;
      startState("doPrimaryUserProvisioned", info);
    });

    subscribe("primary_user_unauthenticated", function(msg, info) {
      info = info || {};
      info.add = !!addPrimaryUser;
      info.email = email;
      info.requiredEmail = !!requiredEmail;
      startState("doVerifyPrimaryUser", info);
    });

    subscribe("primary_user_authenticating", function(msg, info) {
      // Keep the dialog from automatically closing when the user browses to
      // the IdP for verification.
      moduleManager.stopAll();
      self.success = true;
    });

    subscribe("primary_user_ready", function(msg, info) {
      startState("doEmailChosen", info);
    });

    subscribe("pick_email", function() {
      startState("doPickEmail", {
        origin: self.hostname,
        allow_persistent: self.allowPersistent
      });
    });

    subscribe("email_chosen", function(msg, info) {
      var email = info.email
          idInfo = storage.getEmail(email);

      function complete() {
        info.complete && info.complete();
      }

      if(idInfo) {
        if(idInfo.type === "primary") {
          if(idInfo.cert) {
            startState("doEmailChosen", info);
          }
          else {
            // If the email is a primary, and their cert is not available,
            // throw the user down the primary flow.
            // Doing so will catch cases where the primary certificate is expired
            // and the user must re-verify with their IdP.  This flow will
            // generate its own assertion when ready.
            publish("primary_user", info);
          }
        }
        else {
          user.checkAuthentication(function(authentication) {
            if(authentication === "assertion") {
              startState("doAuthenticateWithRequiredEmail", {
                email: email,
                authenticated: false,
                secondary_auth: true
              });
            }
            else {
              startState("doEmailChosen", info);
            }
            complete();
          }, complete);
        }
      }
      else {
        throw "invalid email";
      }
    });

    subscribe("notme", function() {
      startState("doNotMe");
    });

    subscribe("logged_out", function() {
      publish("authenticate");
    });

    subscribe("authenticated", function(msg, info) {
      mediator.publish("pick_email");
    });

    subscribe("forgot_password", function(msg, info) {
      startState("doForgotPassword", info);
    });

    subscribe("reset_password", function(msg, info) {
      startState("doConfirmUser", info.email);
    });

    subscribe("assertion_generated", function(msg, info) {
      self.success = true;
      if (info.assertion !== null) {
        startState("doAssertionGenerated", info.assertion);
      }
      else {
        startState("doPickEmail");
      }
    });

    subscribe("add_email", function(msg, info) {
      startState("doAddEmail");
    });

    subscribe("email_staged", function(msg, info) {
      startState("doConfirmEmail", info.email);
    });

    subscribe("email_confirmed", function() {
      startState("doEmailConfirmed");
    });

    subscribe("cancel_state", function(msg, info) {
      cancelState();
    });

  }

  var StateMachine = BrowserID.Class({
    init: function() {
      // empty
    },

    start: function(options) {
      options = options || {};

      controller = options.controller;
      if (!controller) {
        throw "start: controller must be specified";
      }

      startStateMachine.call(this);
    },

    stop: function() {
      unsubscribeAll();
    }
  });


  bid.StateMachine = StateMachine;
}());

