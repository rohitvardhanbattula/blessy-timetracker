sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "sap/ui/core/Fragment"
], function (Controller, JSONModel, Filter, FilterOperator, MessageToast, MessageBox, Fragment) {
    "use strict";

    return Controller.extend("timetracker.controller.View1", {

        _timerInterval: null,
        _oSubmitDialog: null,
        sHanaServiceUrl: "/hana/time-entries",

        onInit: function () {
            // Initialize models
            var oActiveTimerModel = new JSONModel({
                activeOrderId: null,
                activeOperationId: null
            });
            this.getView().setModel(oActiveTimerModel, "activeTimer");

            var oDialogModel = new JSONModel({
                orderId: null,
                operationId: null,
                workStartDate: null,
                workFinishDate: null,
                actualWork: "0.0",
                confirmationText: "",
                isFinalConfirmation: false,
                contextPath: null,
                timeEntryId: null
            });
            this.getView().setModel(oDialogModel, "dialog");
            
            var oViewStateModel = new JSONModel({
                isProgressPanelVisible: false
            });
            this.getOwnerComponent().setModel(oViewStateModel, "viewState");

            var oDraftsModel = new JSONModel({ entries: [] });
            this.getOwnerComponent().setModel(oDraftsModel, "drafts");

            // Load initial data
            this.loadOrdersAndTimeEntries();
        },

        // Formatter: Remove leading zeros from order ID
        removeLeadingZeros: function(sOrderId) {
            if (!sOrderId) return "";
            return parseInt(sOrderId, 10).toString();
        },

        // Format seconds to HH:MM:SS
        formatTime: function(iTotalSeconds) {
            if (iTotalSeconds === null || iTotalSeconds === undefined) {
                return "00:00:00";
            }
            var hours   = Math.floor(iTotalSeconds / 3600);
            var minutes = Math.floor((iTotalSeconds - (hours * 3600)) / 60);
            var seconds = iTotalSeconds - (hours * 3600) - (minutes * 60);
            if (hours   < 10) {hours   = "0"+hours;}
            if (minutes < 10) {minutes = "0"+minutes;}
            if (seconds < 10) {seconds = "0"+seconds;}
            return hours+':'+minutes+':'+seconds;
        },

        // Load orders and merge with active time entries
        loadOrdersAndTimeEntries: function() {
            var that = this;
            this.fetchOrders().then(function(aOrders) {
                var oOrdersModel = new JSONModel({ orders: aOrders });
                that.getOwnerComponent().setModel(oOrdersModel, "orders");
                
                that.fetchActiveTimeEntries().then(function(aTimeEntries) {
                    that.mergeTimeEntriesWithOrders(aTimeEntries);
                    that._startGlobalTimerInterval();
                    that._updatePanelVisibility();
                });
            });
        },

        // Fetch orders from S/4HANA
        fetchOrders: function() {
            var that = this;
            return new Promise(function(resolve, reject) {
                var sUrl = "/sap/bc/zfmcall/BAPI_ALM_ORDERHEAD_GET_LIST?saml2=disabled&format=json";
                var oPayload = {
                    "IT_RANGES": [ 
                        { 
                            "FIELD_NAME": "OPTIONS_FOR_DOC_TYPE", 
                            "SIGN": "I", 
                            "OPTION": "EQ", 
                            "LOW_VALUE": "EREF" 
                        }, 
                        { 
                            "FIELD_NAME": "SHOW_DOCUMENTS_IN_PROCESS", 
                            "SIGN": "I", 
                            "OPTION": "EQ", 
                            "LOW_VALUE": "X"
                        } 
                    ]
                };

                fetch(sUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(oPayload)
                })
                .then(function(response) {
                    return response.json();
                })
                .then(function(data) {
                    var aOrders = data.et_result || [];
                    
                    if (aOrders.length === 0) {
                        MessageToast.show("No orders found");
                        resolve([]);
                        return;
                    }
                    
                    // Fetch operations for all orders
                    var aOrdersPromises = aOrders.map(function(order) {
                        return that.fetchOperations(order.orderid);
                    });
                    
                    Promise.all(aOrdersPromises).then(function(aAllOperations) {
                        var aFlatOrders = [];
                        
                        // Create flat list of order-operation combinations
                        aAllOperations.forEach(function(aOps, idx) {
                            var oOrder = aOrders[idx];
                            
                            if (aOps.length === 0) {
                                // No operations - skip or show placeholder
                                aFlatOrders.push({
                                    orderId: oOrder.orderid,
                                    orderDesc: oOrder.short_text,
                                    operationId: "----",
                                    operationDesc: "No operations",
                                    workCenter: oOrder.mn_wk_ctr || "",
                                    systemStatus: oOrder.s_status,
                                    reqStartDate: oOrder.start_date + "T07:00:00",
                                    reqEndDate: oOrder.finish_date + "T07:00:00",
                                    assignedTo: "",
                                    activityType: "",
                                    timerState: {
                                        elapsedSeconds: 0,
                                        baseElapsedSeconds: 0,
                                        isRunning: false,
                                        clockInTime: null,
                                        timeEntryId: null
                                    }
                                });
                            } else {
                                // Create entry for each operation
                                aOps.forEach(function(oOp) {
                                    aFlatOrders.push({
                                        orderId: oOrder.orderid,
                                        orderDesc: oOrder.short_text,
                                        operationId: oOp.activity,
                                        operationDesc: oOp.description,
                                        workCenter: oOp.work_cntr,
                                        systemStatus: oOp.s_status,
                                        reqStartDate: oOp.earl_sched_start_date + "T" + oOp.earl_sched_start_time,
                                        reqEndDate: oOp.earl_sched_finish_date + "T" + oOp.earl_sched_finish_time,
                                        assignedTo: oOp.resp_planner || oOrder.plangroup || "",
                                        activityType: oOp.acttype || "",
                                        timerState: {
                                            elapsedSeconds: 0,
                                            baseElapsedSeconds: 0,
                                            isRunning: false,
                                            clockInTime: null,
                                            timeEntryId: null
                                        }
                                    });
                                });
                            }
                        });
                        
                        resolve(aFlatOrders);
                    });
                })
                .catch(function(error) {
                    MessageBox.error("Failed to load orders: " + error.message);
                    resolve([]);
                });
            });
        },

        // Fetch operations for a specific order
        fetchOperations: function(sOrderId) {
            var that = this;
            return new Promise(function(resolve, reject) {
                var sUrl = "/sap/bc/zfmcall/BAPI_ALM_ORDEROPER_GET_LIST?format=json";
                var oPayload = {
                    "DISPLAY_PARAMETERS": {
                        "PAGE_LENGTH": 100,
                        "CURRENT_PAGE": 1
                    },
                    "IT_RANGES": [
                        {
                            "FIELD_NAME": "OPTIONS_FOR_ORDERID",
                            "SIGN": "I",
                            "OPTION": "EQ",
                            "LOW_VALUE": sOrderId,
                            "HIGH_VALUE": ""
                        },
                        {
                            "FIELD_NAME": "SHOW_OPEN_DOCUMENTS",
                            "SIGN": "I",
                            "OPTION": "EQ",
                            "LOW_VALUE": "X",
                            "HIGH_VALUE": ""
                        }
                    ]
                };
                
                fetch(sUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(oPayload)
                })
                .then(function(response) {
                    return response.json();
                })
                .then(function(data) {
                    resolve(data.et_result || []);
                })
                .catch(function(error) {
                    console.error("Failed to fetch operations for order " + sOrderId, error);
                    resolve([]);
                });
            });
        },

        // Fetch active time entries from HANA
        fetchActiveTimeEntries: function() {
            var that = this;
            return new Promise(function(resolve, reject) {
                var sUrl = that.sHanaServiceUrl + "?$filter=STATUS eq 'RUNNING'&format=json";
                
                fetch(sUrl, {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json"
                    }
                })
                .then(function(response) {
                    return response.json();
                })
                .then(function(data) {
                    resolve(data.d ? data.d.results : data.value || []);
                })
                .catch(function(error) {
                    console.error("Failed to fetch time entries", error);
                    resolve([]);
                });
            });
        },

        // Merge time entries with orders
        mergeTimeEntriesWithOrders: function(aTimeEntries) {
            var oOrdersModel = this.getOwnerComponent().getModel("orders");
            var aOrders = oOrdersModel.getProperty("/orders");

            aTimeEntries.forEach(function(oEntry) {
                var oOrder = aOrders.find(function(o) {
                    return o.orderId === oEntry.ORDER_ID && o.operationId === oEntry.OPERATION_ID;
                });
                
                if (oOrder) {
                    oOrder.timerState = {
                        elapsedSeconds: 0,
                        baseElapsedSeconds: oEntry.ELAPSED_SECONDS || 0,
                        isRunning: true,
                        clockInTime: oEntry.PUNCH_IN_TIME,
                        timeEntryId: oEntry.ID
                    };
                }
            });
            
            oOrdersModel.refresh();
        },

        // Start global timer for running timers
        _startGlobalTimerInterval: function() {
            var that = this;
            if (this._timerInterval) {
                return; 
            }
            this._timerInterval = setInterval(function() {
                var oOrdersModel = that.getOwnerComponent().getModel("orders");
                var aOrders = oOrdersModel.getProperty("/orders");
                var bIsAnyTimerRunning = false;

                aOrders.forEach(function(oOrder, i) {
                    if (oOrder.timerState.isRunning) {
                        bIsAnyTimerRunning = true;
                        var sPath = "/orders/" + i;
                        var oTimerState = oOrder.timerState;
                        
                        var sClockInTime = oTimerState.clockInTime;
                        var iBaseSeconds = oTimerState.baseElapsedSeconds;
                        var iSessionSeconds = (new Date().getTime() - new Date(sClockInTime).getTime()) / 1000;
                        var iTotalSeconds = Math.round(iBaseSeconds + iSessionSeconds);
                        
                        oOrdersModel.setProperty(sPath + "/timerState/elapsedSeconds", iTotalSeconds);
                    }
                });

                if (!bIsAnyTimerRunning) {
                    clearInterval(that._timerInterval);
                    that._timerInterval = null;
                }
            }, 1000);
        },

        // Stop specific timer
        _stopSpecificTimer: function(oContext) {
            var sPath = oContext.getPath();
            var oTimerState = oContext.getProperty("timerState");

            if (!oTimerState || !oTimerState.isRunning) {
                 return oTimerState.elapsedSeconds;
            }

            var sClockInTime = oTimerState.clockInTime;
            var iBaseSeconds = oTimerState.baseElapsedSeconds;
            var iSessionSeconds = (new Date().getTime() - new Date(sClockInTime).getTime()) / 1000;
            var iTotalSeconds = Math.round(iBaseSeconds + iSessionSeconds);

            oTimerState.elapsedSeconds = iTotalSeconds;
            oTimerState.isRunning = false;
            oTimerState.clockInTime = null;
            oTimerState.baseElapsedSeconds = iTotalSeconds;
            
            oContext.getModel().setProperty(sPath + "/timerState", oTimerState);
            this._updatePanelVisibility();
            return iTotalSeconds;
        },

        // Update panel visibility
        _updatePanelVisibility: function() {
            var oOrdersModel = this.getOwnerComponent().getModel("orders");
            var oViewStateModel = this.getOwnerComponent().getModel("viewState");
            var aOrders = oOrdersModel.getProperty("/orders");

            if (!aOrders) {
                return;
            }

            var bIsVisible = aOrders.some(function(order) {
                return order.timerState.isRunning === true;
            });
            oViewStateModel.setProperty("/isProgressPanelVisible", bIsVisible);
        },

        // Filter orders based on search
        onFilterOrders: function(oEvent) {
            var sQuery = oEvent.getParameter("newValue");
            var aFilters = [];
            if (sQuery && sQuery.length > 0) {
                 var oFilter = new Filter({
                    filters: [
                        new Filter("orderDesc", FilterOperator.Contains, sQuery),
                        new Filter("operationDesc", FilterOperator.Contains, sQuery),
                        new Filter("orderId", FilterOperator.Contains, sQuery),
                        new Filter("operationId", FilterOperator.Contains, sQuery),
                        new Filter("workCenter", FilterOperator.Contains, sQuery),
                        new Filter("assignedTo", FilterOperator.Contains, sQuery)
                    ],
                    and: false
                });
                aFilters.push(oFilter);
            }
            this.byId("ordersList").getBinding("items").filter(aFilters);
            this.byId("inProgressList").getBinding("items").filter(aFilters);
        },

        // Refresh orders
        onRefreshOrders: function() {
            MessageToast.show("Refreshing orders...");
            this.loadOrdersAndTimeEntries();
        },

        // Select/expand order details
        onSelectOrder: function (oEvent) {
             var oContext = oEvent.getSource().getBindingContext("orders");
             var sOrderId = oContext.getProperty("orderId");
             var sOperationId = oContext.getProperty("operationId");
             var oActiveTimerModel = this.getView().getModel("activeTimer");

             var sCurrentActiveId = oActiveTimerModel.getProperty("/activeOrderId");
             var sCurrentActiveOp = oActiveTimerModel.getProperty("/activeOperationId");

             if (oContext.getProperty("timerState/isRunning")) {
                 return;
             }

             if (sCurrentActiveId === sOrderId && sCurrentActiveOp === sOperationId) {
                 oActiveTimerModel.setProperty("/activeOrderId", null);
                 oActiveTimerModel.setProperty("/activeOperationId", null);
             } else {
                 oActiveTimerModel.setProperty("/activeOrderId", sOrderId);
                 oActiveTimerModel.setProperty("/activeOperationId", sOperationId);
             }
        },

        // Clock in to operation
        onClockIn: function(oEvent) {
            var that = this;
            var oContext = oEvent.getSource().getBindingContext("orders");
            var sOrderId = oContext.getProperty("orderId");
            var sOperationId = oContext.getProperty("operationId");
            var sPunchInTime = new Date().toISOString();

            var oPayload = {
                ORDER_ID: sOrderId,
                OPERATION_ID: sOperationId,
                PUNCH_IN_TIME: sPunchInTime,
                PUNCH_OUT_TIME: null,
                ELAPSED_SECONDS: 0,
                STATUS: "RUNNING"
            };

            fetch(this.sHanaServiceUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(oPayload)
            })
            .then(function(response) {
                return response.json();
            })
            .then(function(data) {
                var sTimeEntryId = data.ID || (data.d && data.d.ID);
                
                var oTimerState = oContext.getProperty("timerState");
                oTimerState.isRunning = true;
                oTimerState.clockInTime = sPunchInTime;
                oTimerState.baseElapsedSeconds = 0;
                oTimerState.timeEntryId = sTimeEntryId;
                
                oContext.getModel().setProperty(oContext.getPath() + "/timerState", oTimerState);
                
                that._startGlobalTimerInterval();
                that._updatePanelVisibility();
                MessageToast.show("Clocked in successfully");
            })
            .catch(function(error) {
                MessageBox.error("Failed to clock in: " + error.message);
            });
        },

        // Clock out from operation
        onClockOut: function(oEvent) {
            var oContext = oEvent.getSource().getBindingContext("orders");
            var sClockOutTime = new Date();
            var sClockInTime = new Date(oContext.getProperty("timerState/clockInTime"));
            var sTimeEntryId = oContext.getProperty("timerState/timeEntryId");

            var iFinalElapsedSeconds = this._stopSpecificTimer(oContext);
            var fActualWorkHours = (iFinalElapsedSeconds / 3600).toFixed(2);
            
            var oDialogModel = this.getView().getModel("dialog");
            oDialogModel.setData({
                orderId: oContext.getProperty("orderId"),
                operationId: oContext.getProperty("operationId"),
                workStartDate: sClockInTime,
                workFinishDate: sClockOutTime,
                actualWork: fActualWorkHours, 
                elapsedSeconds: iFinalElapsedSeconds,
                confirmationText: "",
                isFinalConfirmation: false,
                contextPath: oContext.getPath(),
                timeEntryId: sTimeEntryId
            });

            this.updateTimeEntryOnServer(sTimeEntryId, sClockOutTime.toISOString(), iFinalElapsedSeconds, "STOPPED");
            this.openSubmitDialog();
        },

        // Update time entry on server
        updateTimeEntryOnServer: function(sTimeEntryId, sPunchOutTime, iElapsedSeconds, sStatus) {
            var sUrl = this.sHanaServiceUrl + "('" + sTimeEntryId + "')";
            var oPayload = {
                PUNCH_OUT_TIME: sPunchOutTime,
                ELAPSED_SECONDS: iElapsedSeconds,
                STATUS: sStatus
            };

            fetch(sUrl, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(oPayload)
            })
            .then(function(response) {
                if (!response.ok) {
                    console.error("Failed to update time entry");
                }
            })
            .catch(function(error) {
                console.error("Error updating time entry:", error);
            });
        },

        // Open submit dialog
        openSubmitDialog: function() {
            var that = this;
            if (!this._oSubmitDialog) {
                Fragment.load({
                    name: "timetracker.view.fragment.SubmitDialog",
                    controller: this
                }).then(function (oDialog) {
                    that._oSubmitDialog = oDialog;
                    that.getView().addDependent(that._oSubmitDialog);
                    that._oSubmitDialog.open();
                });
            } else {
                this._oSubmitDialog.open();
            }
        },

        onCloseDialog: function() {
            this._oSubmitDialog.close();
        },

        // Submit confirmation to S/4HANA
        onSubmitConfirmation: function() {
            var oDialogModel = this.getView().getModel("dialog");
            var oData = oDialogModel.getData();
            
            if (!oData.workStartDate || !oData.workFinishDate || !oData.actualWork) {
                MessageBox.error("Please fill in all required time fields.");
                return;
            }
            
            MessageToast.show("Submitting to S/4HANA...");
            this.postConfirmationToBAPI(oData);
        },

        // Post confirmation to BAPI
        postConfirmationToBAPI: function(oData) {
            var that = this;
            var sUrl = "/sap/bc/zfmcall/BAPI_ALM_CONF_CREATE?format=json";
            var oPayload = {
                "ORDERID": oData.orderId,
                "ACTIVITY": oData.operationId,
                "WORK_DATE": this.formatDateForBAPI(oData.workStartDate),
                "FIN_CONF": oData.isFinalConfirmation ? "X" : "",
                "CONF_TEXT": oData.confirmationText,
                "CONF_NO": "",
                "YIELD": 0,
                "SCRAP": 0,
                "WORKACT": parseFloat(oData.actualWork)
            };

            fetch(sUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(oPayload)
            })
            .then(function(response) {
                return response.json();
            })
            .then(function(data) {
                if (data.RETURN && data.RETURN.TYPE === "S") {
                    MessageToast.show("Confirmation posted successfully!");
                    that.updateTimeEntryOnServer(oData.timeEntryId, null, null, "POSTED");
                    that.removeOrderFromList(oData.orderId, oData.operationId);
                    that.onCloseDialog();
                } else {
                    var sErrorMsg = data.RETURN ? data.RETURN.MESSAGE : "Unknown error";
                    throw new Error(sErrorMsg);
                }
            })
            .catch(function(error) {
                MessageBox.error("Network Error: Could not submit. Entry saved to Drafts.", {
                    onClose: function() {
                        that.saveEntryToDrafts(oData, error.message);
                        that.updateTimeEntryOnServer(oData.timeEntryId, null, null, "DRAFT");
                        that.onCloseDialog();
                    }
                });
            });
        },

        // Format date for BAPI
        formatDateForBAPI: function(oDate) {
            var d = new Date(oDate);
            var year = d.getFullYear();
            var month = ("0" + (d.getMonth() + 1)).slice(-2);
            var day = ("0" + d.getDate()).slice(-2);
            return year + "-" + month + "-" + day;
        },

        // Remove order from list after posting
        removeOrderFromList: function(sOrderId, sOperationId) {
            var oOrdersModel = this.getOwnerComponent().getModel("orders");
            var aOrders = oOrdersModel.getProperty("/orders");
            var aNewOrders = aOrders.filter(function(order) {
                return !(order.orderId === sOrderId && order.operationId === sOperationId);
            });
            oOrdersModel.setProperty("/orders", aNewOrders);
        },

        // Save entry to drafts
        saveEntryToDrafts: function(oData, sError) {
            var oDraftsModel = this.getOwnerComponent().getModel("drafts");
            var aEntries = oDraftsModel.getProperty("/entries");
            
            var newDraftEntry = {
                id: Date.now().toString(),
                orderId: oData.orderId,
                operationId: oData.operationId,
                operationDesc: oData.operationDesc || "",
                elapsedSeconds: oData.elapsedSeconds,
                formattedTime: this.formatTime(oData.elapsedSeconds),
                workStartDate: oData.workStartDate,
                workFinishDate: oData.workFinishDate,
                actualWork: oData.actualWork,
                confirmationText: oData.confirmationText,
                isFinalConfirmation: oData.isFinalConfirmation,
                errorText: sError,
                timeEntryId: oData.timeEntryId
            };

            aEntries.unshift(newDraftEntry);
            oDraftsModel.refresh();
        },

        // Post draft entry
        onPostDraft: function(oEvent) {
            var oContext = oEvent.getSource().getBindingContext("drafts");
            var oDraft = oContext.getObject();
            
            MessageToast.show("Retrying post for Order " + oDraft.orderId + "...");
            this.postConfirmationToBAPI(oDraft);
        },

        // Delete draft entry
        onDeleteDraft: function(oEvent) {
            var that = this;
            var oContext = oEvent.getSource().getBindingContext("drafts");
            var oDraft = oContext.getObject();
            var oDraftsModel = this.getOwnerComponent().getModel("drafts");
            var aEntries = oDraftsModel.getProperty("/entries");

            MessageBox.confirm("Are you sure you want to delete this draft entry?", {
                onClose: function(sAction) {
                    if (sAction === MessageBox.Action.OK) {
                        var aNewEntries = aEntries.filter(function(entry) {
                            return entry.id !== oDraft.id;
                        });
                        oDraftsModel.setProperty("/entries", aNewEntries);
                        MessageToast.show("Draft deleted.");
                    }
                }
            });
        }
    });
});
