var AV = require('leanengine');

var moment = require('moment');
//var _ = require('lodash');

var BODY_CHECK_PRICE = 160;
var FREE_HOUSING_DAY = 42;



AV.Cloud.beforeUpdate("People", function(request, response) {

  var peopleName = request.object.get("userName");
  var roomId = request.object.get("room");
  var newOutDate = request.object.get("outDate");
  var objectId = request.object.id;

  console.log('before update people' + objectId );

  var RoomClass = AV.Object.extend("Room");
  var room= new RoomClass();
  room.id = roomId ;

  request.object.set("roomRef", room);

  var People = AV.Object.extend("People");
  var querySameName = new AV.Query(People);
  querySameName.equalTo("userName", peopleName);
  querySameName.first({
    success: function(object) {
      //no same name or is update mode
      if(!object || !request.object.isNew())
      {
        //passed name validation
        if(objectId)
        {
          //update mode
          var queryPeople = new AV.Query(People);
          queryPeople.include("roomRef");
          queryPeople.get(objectId, {
            success: function (targetPeople) {

              console.log('before save people query success');
              var oldOutDate = targetPeople.get('outDate');

              console.log('before save out date: ' + newOutDate + ' object: '+ objectId );

              if (newOutDate && !oldOutDate) {
                console.log('need Calc Rent outdate: ' + newOutDate);
                //update mode && outDate is updated
                var newOutDateYear = moment(newOutDate).year();
                var newOutDateMonth = moment(newOutDate).month();
                var currentYear= moment().year();
                var currentMonth= moment().month();

                if(newOutDateYear != currentYear || currentMonth != newOutDateMonth)
                {
                  response.error('離開日期月份一定要在本月份內');
                }
                else {
                  AV.Cloud.run("memberExitCalculation", { objectId:objectId}).then(function(result) {
                    console.log('memberExitCalculation success');
                  }, function(error) {
                    console.log('memberExitCalculation failure');
                  });

                  response.success();
                }

              }
              else if(!newOutDate && oldOutDate)
              {
                response.error('不允許移除離開日期');
              }
              else {
                response.success();

              }

            },
            error: function(error) {
              response.error(error.message);
            }
          });
        }
        else {
          //create mode
          response.success();
        }

      }
      else {
        var errormsg = peopleName + ' 已經存在, 請使用其它名稱';
        response.error(errormsg);
      }
    },
    error: function(error) {
      response.error(error.message);
    }
  });

});

AV.Cloud.beforeSave("People", function(request, response) {

  var peopleName = request.object.get("userName");
  var roomId = request.object.get("room");
  var newOutDate = request.object.get("outDate");
  var objectId = request.object.id;

  console.log('before save people' + objectId );

  var RoomClass = AV.Object.extend("Room");
  var room= new RoomClass();
  room.id = roomId ;

  request.object.set("roomRef", room);

  var People = AV.Object.extend("People");
  var querySameName = new AV.Query(People);
  querySameName.equalTo("userName", peopleName);
  querySameName.first({
    success: function(object) {
      //no same name or is update mode
      if(!object || !request.object.isNew())
      {
        //notthing happen for create
        response.success();
      }
      else {
        var errormsg = peopleName + ' 已經存在, 請使用其它名稱';
        response.error(errormsg);
      }
    },
    error: function(error) {
      response.error(error.message);
    }
  });

});

AV.Cloud.afterSave("People", function(request, response) {

  var createDate = moment(request.object.get('createdAt'));
  var updateDate = moment(request.object.get('updatedAt'));
  var peopleID = request.object.id;


  var newOutDate = request.object.get("outDate");
  console.log('after save out date: ' + newOutDate);

  var PeopleClass = AV.Object.extend("People");
  var query = new AV.Query(PeopleClass);
  query.get(peopleID, {
    success: function (targetPeople) {

      console.log('after save update people: ' + peopleID);

      var PeopleAccountClass = AV.Object.extend("PeopleAccount");
      var peopleAccount = new PeopleAccountClass();

      peopleAccount.set("runningBalance", 0);
      targetPeople.set("accountRef", peopleAccount);
      targetPeople.save(null,{
        success: function(result) {
          //insert mode, checking fee
          addBodyCheckFee(peopleID);
        },
        error: function(results, error) {

        }
      });
    }
  });

});



//Repayment process


AV.Cloud.afterSave("Payment", function(request, response) {
  var owner = request.object.get("owner");

  var PeopleClass = AV.Object.extend("People");
  var query = new AV.Query(PeopleClass);
  query.include('accountRef');
  query.get(owner.id, {
    success: function (targetPeople) {
      refreshRunningBalance(targetPeople,
        function() {
        },
        function(error)
        {
          console.log(error.message);
        });

    }
  });
});

AV.Cloud.afterUpdate("Payment", function(request, response) {

  var paymentAmount= request.object.get("amount");
  var owner = request.object.get("owner");
  var creator = request.object.get("creator");
  var isApproved = request.object.get("isApproved");
  var paymentId = request.object.id;


  //only approved record need to repay
  if(isApproved ) {
    var FeeClass = AV.Object.extend("Fee");
    var queryFee = new AV.Query(FeeClass);
    queryFee.equalTo("owner", owner);
    queryFee.equalTo("isSettled", false);
    queryFee.include("feeTypeRef");
    queryFee.ascending("createdAt");

    queryFee.find({
      success: function (feeResults) {
        // results has the list of users with a hometown team with a winning record

        //Step1: sort the fee by the priority and date
        feeResults.sort(function (fee1, fee2) {

          var priority1 = fee1.get('feeTypeRef').get('priority');
          var priority2 = fee2.get('feeTypeRef').get('priority');

          if (priority1 < priority2) {
            return -1;
          }
          else if (priority1 === priority2) {
            return 0;
          }
          else {
            return 1;
          }

        });

        //Step2: loop all the list and repay it
        var changedFeeList = [];
        var paymentDetail = '';
        for (var i = 0; i < feeResults.length; i++) {
          var fee = feeResults[i];
          var lendingAmount = fee.get('amount');
          var settledAmount = fee.get('settledAmount');
          var isRentFee = fee.get('feeTypeRef').get('isRentFee');
          var outstandingAmount = lendingAmount - settledAmount;


          if(paymentDetail.length > 0)
          {
            paymentDetail = paymentDetail + ',' ;
          }

          if(isRentFee)
          {
            paymentDetail = paymentDetail + fee.get("reference");
          }
          else {
            paymentDetail = paymentDetail + fee.get('feeTypeRef').get('name');
          }

          if (paymentAmount >= outstandingAmount) {
            //full payment
            fee.set('settledAmount', fee.get('amount'));
            fee.set('isSettled', true);
            fee.set('settledDate', new Date());
            fee.set('settledBy', creator);
            changedFeeList.push(fee);

            paymentAmount = paymentAmount - outstandingAmount;
          }
          else {
            //partial payment
            var newSettledAmount = settledAmount + paymentAmount;
            fee.set('settledAmount', newSettledAmount);
            changedFeeList.push(fee);

            paymentAmount = 0;
            break;
          }
        }

        console.log('paymentDetail : ' + paymentDetail);
        request.object.set('paymentDetail', paymentDetail);

        //refresh after list is saved
        if (changedFeeList.length > 0) {
          AV.Object.saveAll(changedFeeList, {
            success: function (list) {

              request.object.set('paymentDetail', paymentDetail);
              request.object.save().then(function(obj) {
              });

              var PeopleClass = AV.Object.extend("People");
              var query = new AV.Query(PeopleClass);
              query.include('accountRef');
              query.get(owner.id, {
                success: function (targetPeople) {
                  refreshRunningBalance(targetPeople,
                    function () {
                    },
                    function (error) {
                      console.log(error.message);
                    });

                }
              });

            },
            error: function (error) {
            }
          });
        }
        else {
        }

      },
      error: function (error) {
      }
    });
  }
  else {
  }

});


AV.Cloud.beforeSave("Fee", function(request, response)
{
  var feeType = request.object.get("feeType");

  var FeeTypeClass = AV.Object.extend("FeeType");
  var fee= new FeeTypeClass();
  fee.id = feeType ;

  request.object.set("feeTypeRef", fee);
  response.success();
});


AV.Cloud.afterSave("Fee", function(request, response) {

  var owner = request.object.get("owner");
  var ownerID = owner.id;
  var feeID = request.object.id;

  var createDate = moment(request.object.get('createdAt'));
  var updateDate = moment(request.object.get('updatedAt'));
  var creator = request.object.get("creator");

  //for only client side create, upload balance
  if(createDate.isSame(updateDate))
  {

    if (ownerID.length > 0) {
      var PeopleClass = AV.Object.extend("People");
      var query = new AV.Query(PeopleClass);
      query.include('accountRef');
      console.log("Fee after create query: " + ownerID);

      query.get(ownerID, {
        success: function (targetPeople) {

          var runningBalance = targetPeople.get('accountRef').get('runningBalance');
          if(runningBalance > 0)
          {
            var FeeClass = AV.Object.extend("Fee");
            var queryFee = new AV.Query(FeeClass);

            queryFee.get(feeID, {
              success: function (targetFee) {
                var amount = targetFee.get('amount');
                var settledAmount = 0;

                if(runningBalance >= amount)
                {
                  //change to settle status
                  settledAmount = amount;
                  targetFee.set("settledAmount", settledAmount);
                  targetFee.set("isSettled", true);
                  targetFee.set('settledBy', creator);
                  targetFee.set('settledDate', new Date());
                }
                else {
                  settledAmount = runningBalance;
                  targetFee.set("settledAmount", settledAmount);
                }

                targetFee.save(null,{
                  success: function(result) {
                    refreshRunningBalance(targetPeople,
                      function() {
                      },
                      function(error)
                      {
                        console.log(error.message);
                      });

                  },
                  error: function(results, error) {
                    response.error("fee after safve error");
                  }
                });
              }
            });
          }
          else {
            //no need edit fee
            refreshRunningBalance(targetPeople,
              function() {
              },
              function(error)
              {
                console.log(error.message);
              });
          }
        },
        error: function (object, error) {
          response.error("fee after safve error");
        }
      });
    }
  }
  else{
    //server side update, refresh balance
    console.log('server side update fee ready to recalc balsnce.');
    refreshRunningBalance(targetPeople,
      function() {
      },
      function(error)
      {
        console.log(error.message);
      });
  }
});

//Cloud function
AV.Cloud.define("approvePayment", function(request, respond) {
  var approveIDList = request.params.approveList;
  var rejectIDList = request.params.rejectList;

  var PaymentClass = AV.Object.extend("Payment");
  var queryApprovedPayment = new AV.Query(PaymentClass);
  queryApprovedPayment.equalTo("isApproved", false);
  queryApprovedPayment.containedIn("objectId", approveIDList );

  var queryRejectedPayment = new AV.Query(PaymentClass);
  queryRejectedPayment.equalTo("isApproved", false);
  queryRejectedPayment.containedIn("objectId", rejectIDList);

  queryRejectedPayment.find({
    success: function(rejectList)
    {
      AV.Object.destroyAll(rejectList).then(function(success) {
        // All the objects were deleted
        queryApprovedPayment.find(
          {
            success: function(approveList)
            {
              for(var i = 0 ; i < approveList.length ; i++)
              {
                approveList[i].set('isApproved', true);
              }

              AV.Object.saveAll(approveList, {
                success: function (list) {
                  respond.success();
                },
                error: function (error) {
                  respond.error(error.message);
                }
              });

            },
            error: function(error)
            {
              respond.error(error.message);
            }
          });


      }, function(error) {
        respond.error(error.message);
      });
    },
    error: function(error)
    {
      respond.error(error.message);
    }
  });

});

AV.Cloud.define("memberExitCalculation", function(request, response)
{
  var objectId = request.params.objectId;

  //update mode
  var People = AV.Object.extend("People");
  var queryPeople = new AV.Query(People);
  queryPeople.include("roomRef");
  queryPeople.get(objectId, {
    success: function (targetPeople) {


      var freeHousingDay = FREE_HOUSING_DAY;

      var FeeTypeClass = AV.Object.extend("FeeType");
      var queryFeeType = new AV.Query(FeeTypeClass);
      queryFeeType.equalTo("isRentFee", true);

      //not exit pls

      queryFeeType.first({
        success: function (rentFee) {
          //override the out date
          var newOutDate = targetPeople.get("outDate");

          console.log('rentFeeCalculator: ' + targetPeople.get('outDate'));

          if(newOutDate )
          {
            var monthStart = moment(newOutDate).utcOffset(8).startOf('month');
            var monthEnd = moment(newOutDate).utcOffset(8).endOf('month');

            rentFeeCalculator(targetPeople, rentFee, monthStart, monthEnd, freeHousingDay, false, function() {
              //success
              refreshRunningBalance(targetPeople,
                function() {
                },
                function(error)
                {
                  console.log(error.message);
                });

            }, function() {
              //fail
            });

          }
          response.success();

        },
        error: function (error) {
          response.error(error.message);
        }
      });

    },
    error: function(error) {
      response.error(error.message);
    }
  });
});

AV.Cloud.define("queryNetgativeMember", function(request, respond)
{
  var People = AV.Object.extend("People");
  var query = new AV.Query(People);
  query.include("roomRef");
  query.include("accountRef");

  query.find({
    success: function (results) {

      var netgativeUserList = [];

      for(var i = 0; i < results.length ; i++)
      {
        var people = results[i];
        var hasAssist = people.get("hasAssist");
        var outDate = people.get("outDate");
        var runningBalance = people.get('accountRef').get("runningBalance");

        if(runningBalance >= 0)
        {
          continue;
        }

        var roomPrice = 0;
        if(hasAssist )
        {
          roomPrice = people.get("roomRef").get("assistPrice");
        }else {
          roomPrice =  people.get("roomRef").get("nonAssistPrice");
        }

        if(outDate)
        {
          //if outed, even -1 need to showup
          netgativeUserList.push(people);
        }
        else {
          console.log("query netgative member balanace: " + runningBalance + " room price: " + roomPrice );
          //not yet out, show only netgative 2 month
          if(Math.abs(runningBalance) >= roomPrice *2)
          {
            netgativeUserList.push(people);
          }
        }

      }

      respond.success(netgativeUserList);
    },
    error: function(error)
    {
      respond.error(error.message);
    }
  });

});

//
//
////shedual job
AV.Cloud.define("addBodyCheckFee", function(request, status) {

  var peopleID = request.params.objectId;
  addBodyCheckFee(peopleID);

});


AV.Cloud.define("monthEndCalculation", function(request, status)
{
  //On 1st day of month, calculate last month's rent
  var dateFormat = 'YYYY-MM-DD';
  var currentDate = moment();
  var monthStart = moment().startOf('month');
  var monthEnd = moment().endOf('month');

  //var currentDay   = currentDate.date();
  //var currentMonth = currentDate.month();

  var numberOfDaysInMonth = monthEnd.date();

  console.log('monthEndCalculation: start: ' + monthStart.format(dateFormat) + ' end: ' + monthEnd.format(dateFormat) + ' # of days in month: ' + numberOfDaysInMonth);
  //****** important these task must be run in first day

  //if(day != 1)
  //{
  //
  //}

  var freeHousingDay = FREE_HOUSING_DAY;

  var FeeTypeClass= AV.Object.extend("FeeType");
  var queryFeeType = new AV.Query(FeeTypeClass);
  queryFeeType.equalTo("isRentFee", true);

  var PeopleClass = AV.Object.extend("People");
  var queryPeople = new AV.Query(PeopleClass);
  queryPeople.include("roomRef");
  queryPeople.equalTo("outDate", null);
  //not exit pls

  queryFeeType.first({
    success: function(rentFee)
    {
      queryPeople.find({
        success: function(results) {
          for (var i = 0; i < results.length; i++) {
            //call function
            //function rentFeeCalculator(people, rentFee, monthStart, monthEnd)
            var people = results[i];

            rentFeeCalculator(people, rentFee, monthStart, monthEnd, freeHousingDay, true, function()
            {

            }, function(error)
            {

            });
          }
        },
        error: function(error) {
          console.error('monthEndCalculation running query error!');
        }
      });
    },
    error: function(error)
    {
      console.error('monthEndCalculation running query error!');
    }
  });


});


//custom function!!!

//Pass all parameter to calculate a people rent fee in particular month
function rentFeeCalculator(people, rentFee, monthStart, monthEnd, freeHousingDay, isInsertMode, successCallBack, errorCallBack)
{
  var dateFormat = 'YYYY-MM-DD';
  //for calculator use
  var overridedMonthStart = monthStart;
  var overridedMonthEnd = monthEnd;

  var reference = overridedMonthStart.format('MMMM') + ' 租金';

  var numberOfDaysInMonth = monthEnd.date();

  //one person;
  var room = people.get('roomRef');

  var outDateStr = people.get('outDate');
  var inDateStr = people.get('inDate');

  var outDate = moment(outDateStr).utcOffset(8);
  var inDate = moment(inDateStr).utcOffset(8);

  //Special discount: 42days free housing
  inDate = inDate.add(freeHousingDay, 'days');

  var hasPartialDay =  false;

  console.log('calculateRentFee: people: ' + people.get('userName') + ' outDate: ' + outDateStr + ' inDate: ' + inDateStr + ' discountInDate: ' + inDate);

  //1. out date must be valid
  if(outDateStr === undefined)
  {
  }
  else {
    if(monthStart.isAfter(outDate))
    {
      console.log('calculateRentFee: exit home already.');
      //already exit home
      return;
    }

    if(outDate.isAfter(monthStart) &&
      monthEnd.isAfter(outDate) )
    {
      //partial case
      overridedMonthEnd = outDate;
      hasPartialDay = true;
    }
  }

  //2. in date must be valid
  if(inDate.isAfter(monthEnd))
  {
    //no need calc if inDate is future (still in discount period)
    console.log('calculateRentFee: inDate is future.');
    return;
  }else if(inDate.isAfter(monthStart)) {
    overridedMonthStart = inDate;
    hasPartialDay = true;
  }


  //3. calc ratio if the
  var ratio = 1.0;
  if(hasPartialDay)
  {
    var numberOfDiffDay = overridedMonthEnd.diff(overridedMonthStart, 'days') + 1;
    ratio = numberOfDiffDay / numberOfDaysInMonth;

    console.log('calculateRentFee: people: ' + people.get('userName') + ' overrideMonthStart: ' + overridedMonthStart.format(dateFormat) + ' overrideMonthEnd: ' + overridedMonthEnd.format(dateFormat) + ' dayDiff: ' + numberOfDiffDay);
  }

  //4. calc amount
  var amount;
  if(people.hasAssist)
  {
    //use assist price
    amount = ratio * room.get('assistPrice');
  }
  else {
    amount = ratio * room.get('nonAssistPrice');
  }

  //round to nearest dollar
  amount = Math.round(amount);
  console.log('calculateRentFee: room: ' + room.get('name') + ' assistPrice: ' + room.get('assistPrice') + ' nonAssistPrice: ' + room.get('nonAssistPrice') + ' ratio: ' + ratio + 'final amt: ' + amount);

  var FeeClass = AV.Object.extend("Fee");
  if(isInsertMode)
  {
    //month end mode
    var fee = new FeeClass();

    console.log('calculateRentFee ready for save fee: ' + rentFee.id + ' people id: ' + people.id);

    fee.set("amount", amount);
    fee.set("settledAmount", 0);
    fee.set("isSettled", false);
    fee.set("feeType", rentFee.id);
    fee.set("feeTypeRef", rentFee);
    fee.set("owner", people);
    fee.set("reference", reference);
    fee.set("creator", people.get('creator'));
    fee.save(null,{
      success: function(result) {
        console.log('calculateRentFee success');
        successCallBack();
      },
      error: function(results, error) {
        errorCallBack(error);
      }
    });
  }
  else {
    //stop in middle mode

    var queryFee = new AV.Query(FeeClass);
    queryFee.equalTo("owner", people);
    queryFee.equalTo("feeType", rentFee.id);
    queryFee.descending("createdAt");

    queryFee.first({
      success: function (targetedFee) {

        var settledAmount = targetedFee.get("settledAmount");
        if (settledAmount > amount) {
          //if new amount > settled amount, settle the fee (but not change the fee settled amount)
          targetedFee.set("isSettled", true);
        }

        targetedFee.set("amount", amount);
        targetedFee.save(null, {
          success: function (result) {
            console.log('update fee success. (For quit people)');
            successCallBack();
          },
          error: function (results, error) {
            errorCallBack(error);
          }
        });
      },
      error: function(error) {
        console.log('No update fee selected. (For quit people)');
      }
    });
  }

}

function addBodyCheckFee(peopleID)
{
  console.log('addBodyCheckFeeRunning:' + peopleID);
  if (peopleID.length > 0)
  {
    var FeeTypeClass= AV.Object.extend("FeeType");
    var queryFeeType = new AV.Query(FeeTypeClass);
    queryFeeType.equalTo("isBodyCheckFee", true);

    var PeopleClass= AV.Object.extend("People");
    var queryPeople = new AV.Query(PeopleClass);
    queryFeeType.first({
        success: function(bodyCheckFee)
        {
          queryPeople.get(peopleID, {
            success: function (targetPeople) {
              // The object was retrieved successfully.

              //get config
              var bodyCheckPrice = BODY_CHECK_PRICE;
              if (targetPeople.get('hasBodyCheck')) {

                var FeeClass = AV.Object.extend("Fee");
                var fee = new FeeClass();

                fee.set("amount", bodyCheckPrice);
                fee.set("settledAmount", 0);
                fee.set("isSettled", false);
                fee.set("feeType", bodyCheckFee.id);
                fee.set("feeTypeRef", bodyCheckFee);
                fee.set("owner", targetPeople);
                fee.save(null,{
                  success: function(result) {
                  },
                  error: function(results, error) {
                  }
                });

              }

            },
            error: function (object, error) {
              // The object was not retrieved successfully.
              // error is a Parse.Error with an error code and message.
            }
          });
        },
        error: function(error)
        {
        }
      }

    );
  }
}


function refreshRunningBalance(targetPeople, successCallBack, errorCallBack)
{
  console.log('refreshRunningBalance people: ' + targetPeople.get('userName'));

  var FeeClass = AV.Object.extend("Fee");
  var queryFee = new AV.Query(FeeClass);
  queryFee.equalTo("owner", targetPeople);

  var PaymentClass = AV.Object.extend("Payment");
  var queryPayment = new AV.Query(PaymentClass);
  queryPayment.equalTo("isApproved", true);

  //queryFee.equalTo("isSettled", false);
  queryFee.find({
    success: function(outstandingFees) {

      queryPayment.equalTo("owner", targetPeople);
      queryPayment.find({
        success: function (paymentLists) {

          var runningBalance = 0.0;
          for (var i = 0; i < outstandingFees.length; i++) {

            var outstandingFee = outstandingFees[i];
            var feeAmount = outstandingFee.get('amount') ;

            runningBalance = runningBalance - feeAmount;
          }


          for (var i = 0; i < paymentLists.length; i++)
          {
            var payment = paymentLists[i];
            runningBalance = runningBalance + payment.get('amount');
          }

          var paymentAccount = targetPeople.get('accountRef');
          paymentAccount.set('runningBalance', runningBalance);
          paymentAccount.save();

          successCallBack();

          console.log('refreshRunningBalance people: ' + targetPeople.get('userName') + ' running balance: ' + runningBalance);
        },
        error: function(error)
        {
          errorCallBack(error);
        }
      });


    }

  });

}


module.exports = AV.Cloud;
