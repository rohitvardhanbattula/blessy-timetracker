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
            var oBusyModel = new JSONModel({ busy: false });
            this.getView().setModel(oBusyModel, "busy");

            var oActiveTimerModel = new JSONModel({ activeOrderId: null, activeOperationId: null });
            this.getView().setModel(oActiveTimerModel, "activeTimer");

            var oDialogModel = new JSONModel({
                orderId: null, operationId: null, workStartDate: null, workFinishDate: null,
                actualWork: "0.0", confirmationText: "", isFinalConfirmation: false, contextPath: null, timeEntryId: null
            });
            this.getView().setModel(oDialogModel, "dialog");

            var oViewStateModel = new JSONModel({ isProgressPanelVisible: false });
            this.getOwnerComponent().setModel(oViewStateModel, "viewState");

            var oDraftsModel = new JSONModel({ entries: [] });
            this.getOwnerComponent().setModel(oDraftsModel, "drafts");

            this.loadOrdersAndTimeEntries();
        },

        removeLeadingZeros: function (sOrderId) {
            if (!sOrderId) return "";
            return parseInt(sOrderId, 10).toString();
        },

        formatTime: function (iTotalSeconds) {
            if (iTotalSeconds === null || iTotalSeconds === undefined) return "00:00:00";
            let h = Math.floor(iTotalSeconds / 3600);
            let m = Math.floor((iTotalSeconds % 3600) / 60);
            let s = iTotalSeconds % 60;
            return [h, m, s].map(v => (v < 10 ? "0" : "") + v).join(':');
        },

        async loadOrdersAndTimeEntries() {
            this.getView().getModel("busy").setProperty("/busy", true);
            try {
                const aOrders = await this.fetchOrders();
                let oOrdersModel = new JSONModel({ orders: [] });
                this.getOwnerComponent().setModel(oOrdersModel, "orders");

                const aOrderIDs = aOrders.map(o => o.orderid);

                // Parallel fetch all operations for each order
                const aOperationsLists = await Promise.all(aOrderIDs.map(id => this.fetchOperations(id)));

                // Compile orders with at least one operation
                const aFlatOrders = [];

                aOrders.forEach((oOrder, idx) => {
                    const ops = aOperationsLists[idx] || [];
                    if (ops.length > 0) {
                        ops.forEach(oOp => {
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

                oOrdersModel.setProperty("/orders", aFlatOrders);

                const aTimeEntries = await this.fetchActiveTimeEntries();
                this.mergeTimeEntriesWithOrders(aTimeEntries);
                this._startGlobalTimerInterval();
                this._updatePanelVisibility();
            } catch (err) {
                MessageBox.error("Error loading orders and operations: " + err.message);
            } finally {
                this.getView().getModel("busy").setProperty("/busy", false);
            }
        },

        async loadOrdersAndTimeEntriesFiltered(sOrderIdFilter) {
            this.getView().getModel("busy").setProperty("/busy", true);
            try {
                const aOrders = await this.fetchOrders(sOrderIdFilter);
                let oOrdersModel = new JSONModel({ orders: [] });
                this.getOwnerComponent().setModel(oOrdersModel, "orders");

                const aOrderIDs = aOrders.map(o => o.orderid);

                const aOperationsLists = await Promise.all(aOrderIDs.map(id => this.fetchOperations(id)));

                const aFlatOrders = [];
                aOrders.forEach((oOrder, idx) => {
                    const ops = aOperationsLists[idx] || [];
                    if (ops.length > 0) {
                        ops.forEach(oOp => {
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

                oOrdersModel.setProperty("/orders", aFlatOrders);

                const aTimeEntries = await this.fetchActiveTimeEntries();
                this.mergeTimeEntriesWithOrders(aTimeEntries);
                this._startGlobalTimerInterval();
                this._updatePanelVisibility();
            } catch (err) {
                MessageBox.error("Error loading filtered orders and operations: " + err.message);
            } finally {
                this.getView().getModel("busy").setProperty("/busy", false);
            }
        },

        async fetchOrders(sOrderIdFilter) {
            try {
                const sUrl = "/sap/bc/zfmcall/BAPI_ALM_ORDERHEAD_GET_LIST?saml2=disabled&format=json";
                let aRanges = [
                    { "FIELD_NAME": "OPTIONS_FOR_DOC_TYPE", "SIGN": "I", "OPTION": "EQ", "LOW_VALUE": "EREF" },
                    { "FIELD_NAME": "SHOW_DOCUMENTS_IN_PROCESS", "SIGN": "I", "OPTION": "EQ", "LOW_VALUE": "X" },
                    { "FIELD_NAME": "SHOW_OPEN_DOCUMENTS" },
                    { "FIELD_NAME": "SHOW_DOCS_WITH_FROM_DATE", "SIGN": "I", "OPTION": "EQ" },
                    { "FIELD_NAME": "SHOW_DOCS_WITH_TO_DATE", "SIGN": "I", "OPTION": "EQ", "LOW_VALUE": "99991231" }
                ];
                if (sOrderIdFilter && sOrderIdFilter.length > 0) {
                    aRanges.push({
                        "FIELD_NAME": "OPTIONS_FOR_ORDERID",
                        "SIGN": "I",
                        "OPTION": "CP",
                        "LOW_VALUE": "*" + sOrderIdFilter + "*"
                    });
                }
                const oPayload = { "DISPLAY_PARAMETERS": { "PAGE_LENGTH": 50 }, "IT_RANGES": aRanges };
                const response = await fetch(sUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(oPayload)
                });
                const data = await response.json();
                return data.et_result || [];
            } catch (error) {
                MessageBox.error("Failed to load orders: " + (error.message || error));
                return [];
            }
        },

        async fetchOperations(sOrderId) {
            try {
                const sUrl = "/sap/bc/zfmcall/BAPI_ALM_ORDEROPER_GET_LIST?format=json";
                const oPayload = {
                    "DISPLAY_PARAMETERS": { "PAGE_LENGTH": 25, "CURRENT_PAGE": 1 },
                    "IT_RANGES": [
                        { "FIELD_NAME": "OPTIONS_FOR_ORDERID", "SIGN": "I", "OPTION": "EQ", "LOW_VALUE": sOrderId, "HIGH_VALUE": "" },
                        { "FIELD_NAME": "SHOW_OPEN_DOCUMENTS", "SIGN": "I", "OPTION": "EQ", "LOW_VALUE": "X", "HIGH_VALUE": "" }
                    ]
                };
                const response = await fetch(sUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(oPayload)
                });
                const data = await response.json();
                return data.et_result || [];
            } catch (error) {
                console.error("Failed to fetch operations for order " + sOrderId, error);
                return [];
            }
        },

        fetchActiveTimeEntries: function () {
            var that = this;
            return new Promise(function (resolve) {
                var sUrl = that.sHanaServiceUrl + "?$filter=STATUS eq 'RUNNING'&format=json";

                fetch(sUrl, {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json"
                    }
                })
                    .then(function (response) {
                        return response.json();
                    })
                    .then(function (data) {
                        resolve(data.d ? data.d.results : data.value || []);
                    })
                    .catch(function (error) {
                        console.error("Failed to fetch time entries", error);
                        resolve([]);
                    });
            });
        },

        mergeTimeEntriesWithOrders: function (aTimeEntries) {
            var oOrdersModel = this.getOwnerComponent().getModel("orders");
            var aOrders = oOrdersModel.getProperty("/orders");

            aTimeEntries.forEach(function (oEntry) {
                var oOrder = aOrders.find(function (o) {
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

        _startGlobalTimerInterval: function () {
            var that = this;
            if (this._timerInterval) {
                return;
            }
            this._timerInterval = setInterval(function () {
                var oOrdersModel = that.getOwnerComponent().getModel("orders");
                var aOrders = oOrdersModel.getProperty("/orders");
                var bIsAnyTimerRunning = false;

                aOrders.forEach(function (oOrder, i) {
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

        _stopSpecificTimer: function (oContext) {
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

        _updatePanelVisibility: function () {
            var oOrdersModel = this.getOwnerComponent().getModel("orders");
            var oViewStateModel = this.getOwnerComponent().getModel("viewState");
            var aOrders = oOrdersModel.getProperty("/orders");

            if (!aOrders) {
                return;
            }

            var bIsVisible = aOrders.some(function (order) {
                return order.timerState.isRunning === true;
            });
            oViewStateModel.setProperty("/isProgressPanelVisible", bIsVisible);
        },

        onSearchOrders: function (oEvent) {
    var that = this;
    var oSearchField = this.byId("orderIdSearch"); 
    var sQuery = oSearchField ? oSearchField.getValue().trim() : "";

    if (this._filterDebounceTimer) {
        clearTimeout(this._filterDebounceTimer);
    }

    this._filterDebounceTimer = setTimeout(function () {
        if (!sQuery || sQuery.length < 3) { 
            that.loadOrdersAndTimeEntries();
        } else {
            that.loadOrdersAndTimeEntriesFiltered(sQuery);
        }
    }, 400); 
}

        ,

        onRefreshOrders: function () {
            MessageToast.show("Refreshing orders...");
            this.loadOrdersAndTimeEntries();
        },

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

        onClockIn: function (oEvent) {
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
                .then(function (response) {
                    return response.json();
                })
                .then(function (data) {
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
                .catch(function (error) {
                    MessageBox.error("Failed to clock in: " + error.message);
                });
        },

        onClockOut: function (oEvent) {
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

        updateTimeEntryOnServer: function (sTimeEntryId, sPunchOutTime, iElapsedSeconds, sStatus) {
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
                .then(function (response) {
                    if (!response.ok) {
                        console.error("Failed to update time entry");
                    }
                })
                .catch(function (error) {
                    console.error("Error updating time entry:", error);
                });
        },

        openSubmitDialog: function () {
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

        onCloseDialog: function () {
            this._oSubmitDialog.close();
        },

        onSubmitConfirmation: function () {
            var oDialogModel = this.getView().getModel("dialog");
            var oData = oDialogModel.getData();

            if (!oData.workStartDate || !oData.workFinishDate || !oData.actualWork) {
                MessageBox.error("Please fill in all required time fields.");
                return;
            }

            MessageToast.show("Submitting to S/4HANA...");
            this.postConfirmationToBAPI(oData);
        },

        postConfirmationToBAPI: function (oData) {
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
                .then(function (response) {
                    return response.json();
                })
                .then(function (data) {
                    if (data.RETURN && data.RETURN.TYPE === "S") {
                        MessageToast.show("Confirmation posted successfully!");
                        that.updateTimeEntryOnServer(oData.timeEntryId, null, null, "POSTED");
                        that.onCloseDialog();
                    } else {
                        var sErrorMsg = data.RETURN ? data.RETURN.MESSAGE : "Unknown error";
                        throw new Error(sErrorMsg);
                    }
                })
                .catch(function (error) {
                    MessageBox.error("Network Error: Could not submit. Entry saved to Drafts.", {
                        onClose: function () {
                            that.saveEntryToDrafts(oData, error.message);
                            that.updateTimeEntryOnServer(oData.timeEntryId, null, null, "DRAFT");
                            that.onCloseDialog();
                        }
                    });
                });
        },

        formatDateForBAPI: function (oDate) {
            var d = new Date(oDate);
            var year = d.getFullYear();
            var month = ("0" + (d.getMonth() + 1)).slice(-2);
            var day = ("0" + d.getDate()).slice(-2);
            return year + "-" + month + "-" + day;
        },

        saveEntryToDrafts: function (oData, sError) {
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

        onPostDraft: function (oEvent) {
            var oContext = oEvent.getSource().getBindingContext("drafts");
            var oDraft = oContext.getObject();

            MessageToast.show("Retrying post for Order " + oDraft.orderId + "...");
            this.postConfirmationToBAPI(oDraft);
        },

        onDeleteDraft: function (oEvent) {
            var that = this;
            var oContext = oEvent.getSource().getBindingContext("drafts");
            var oDraft = oContext.getObject();
            var oDraftsModel = this.getOwnerComponent().getModel("drafts");
            var aEntries = oDraftsModel.getProperty("/entries");

            MessageBox.confirm("Are you sure you want to delete this draft entry?", {
                onClose: function (sAction) {
                    if (sAction === MessageBox.Action.OK) {
                        var aNewEntries = aEntries.filter(function (entry) {
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
