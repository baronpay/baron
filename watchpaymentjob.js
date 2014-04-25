var config = require('./config');
var request = require('request');
var helper = require('./helper');
var db = require('./db');

// TODO: This job can be removed in the future, we can calculate
// The confirmations of our watched payments based on our stored
// last known block. Remove in the future.

function updateWatchedPayment(payment, invoice, body) {
  var oldStatus = payment.status;
  var oldBlockHash = payment.block_hash;

  var transaction;
  try {
    transaction = JSON.parse(body);
  }
  catch (err) {
    console.log('Error parsing transaction from body: ' + body);
    transaction = null;
  }

  if (transaction) {
    var newConfirmations = transaction.confirmations;
    var newStatus = helper.getPaymentStatus(payment, newConfirmations, invoice);
    payment.status = oldStatus === newStatus ? oldStatus : newStatus;

    var newBlockHash = transaction.blockhash ? transaction.blockhash : null;
    payment.block_hash = oldBlockHash === newBlockHash ? oldBlockHash : newBlockHash;
    // payments confirmations have reached 100 (Default) confs stop watching.
    var stopTracking = newConfirmations >= config.trackPaymentUntilConf;
    payment.watched = !stopTracking;
    if (stopTracking || (newStatus && newStatus !== oldStatus) || (newBlockHash && newBlockHash !== oldBlockHash)) {
      db.insert(payment);
      console.log('Updating: { ' + payment.address + '[' + payment.watched + '] }');
    }
  }
  else { //Payment has no transaction data. This means it has most likely not been paid. Expire if passes paymentValidForMinutes var
    var curTime = new Date().getTime();
    var expirationTime = Number(payment.created) + config.paymentValidForMinutes * 60 * 1000;
    // If newConfirmations is null, there were no transactions for this payment
    if(payment.status === 'unpaid' && expirationTime < curTime) {
      payment.watched = false;
      db.insert(payment);
    }
  }
}

var watchPaymentsJob = function () {
  db.getWatchedPayments(function (err, paymentsArr) {
    if (err || !paymentsArr) { console.log(err); return; }
    // Proccess all watched payments
    console.log('===========================');
    console.log('Watch Payments Job: ' + paymentsArr.length);
    console.log('===========================');
    var paidCount = 0;
    var unpaidCount = 0;
    paymentsArr.forEach(function(payment) {
      // TODO: Do I need logic for expired invoices here?
      if (payment.tx_id) { // payment received, now watching
        paidCount++;
        db.findInvoice(payment.invoice_id, function (err, invoice) {
          if (err) { console.log(err); return; }
          // Build insight url from config
          var insightUrl = config.insight.protocol + '://' + config.insight.host + ':' + config.insight.port;
          var requestUrl = insightUrl + '/api/tx/' + payment.tx_id;
          // Ask the insight api for transaction data for this payment address
          request(requestUrl, function (error, response, body) {
            updateWatchedPayment(payment, invoice, body);
          });
        });
      }
      else { // payment not received
        unpaidCount++;
        updateWatchedPayment(payment, null, null);
      }
    });
    console.log('> Watched Paid Count: ' + paidCount);
    console.log('> Watched Unpaid Count: ' + unpaidCount);
  });
};

var runWatchPaymentsJob = function () {
  setInterval(function(){
    watchPaymentsJob();
  }, config.updateWatchListInterval);
};

module.exports = {
  runWatchPaymentsJob:runWatchPaymentsJob,
  watchPaymentsJob: watchPaymentsJob
};